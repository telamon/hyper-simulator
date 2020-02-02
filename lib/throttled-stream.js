// SPDX-License-Identifier: AGPL-3.0-or-later
const { Duplex } = require('streamx')
const FIFO = require('fast-fifo')
function peekPatch () {
  const val = this.tail.buffer[this.tail.btm]
  if (val === undefined && this.tail.next) {
    return this.tail.next.buffer[this.tail.next.btm]
  }
  return val
}
FIFO.prototype.peek = peekPatch

// const debug = console.log

class BufferedThrottleStream extends Duplex {
  /**
   * @param linkRate {Number} - max allowed bytes per second (default: 1Mbit)
   * @param latency {Number} - Link latency in ms
   */
  constructor (src, dst) {
    super({
      write: (data, cb) => this.__write(true, data, cb)
    })

    this.out = new Duplex({
      write: (data, cb) => this.__write(false, data, cb),
      final: cb => this._final(cb, true),
      destroy: cb => this._destroy(cb, true)
    })

    this.lastTick = 0
    this.carryRx = 0
    this.carryTx = 0
    this.rxBytes = 0
    this.txBytes = 0
    this.budgetRx = 0
    this.budgetTx = 0

    this.bufferA = new FIFO()
    this.bufferB = new FIFO()
    this.finishedA = false
    this.finishedB = false
  }

  _destroy (callback, byRemote) {
    return this.__write(!byRemote, null, callback)
    /* Above line gracefully ends the dangling stream,
     * code below forcefully destroys it disregarding any drained reads.
    const other = byRemote ? this : this.out
    if (!other.destroying && !other.destroyed) other.destroy(null)
    cb() */
  }

  _final (callback, byRemote) {
    this.__write(!byRemote, null, callback)
  }

  __write (dir, data, callback) {
    const buffer = dir ? this.bufferB : this.bufferA
    // debug('ENQUEUE', dir ? 'TX' : 'RX', data)
    if (data === null) callback()
    buffer.push({
      data,
      callback: data !== null ? callback : () => {}
    })
  }

  tick (iteration, budget) {
    let rx = 0
    let tx = 0
    if (this.destroyed) this.finishedA = true
    if (this.out.destroyed) this.finishedB = true
    const summary = {
      rx,
      tx,
      noop: true,
      rxEnd: this.finishedA,
      txEnd: this.finishedB,
      lastTick: this.lastTick,
      rxDrained: this.bufferA.isEmpty(),
      txDrained: this.bufferB.isEmpty()
    }

    if (this.finishedA && this.finishedB) return summary
    if (iteration <= this.lastTick) return summary
    summary.noop = false

    let rxDone = false
    let txDone = false
    while (!rxDone || !txDone) {
      // Process receives
      if (!rxDone) {
        if (this.bufferA.isEmpty()) {
          // debug('RXDEQUE', 'empty')
          rxDone = true
        } else if (this.bufferA.peek().data === null) {
          const { callback } = this.bufferA.shift()
          this.push(null)
          rxDone = true
          this.finishedA = true
          callback(null)
          // debug('RXDEQUE', null)
        } else {
          let n = this.bufferA.peek().data.length
          if (n > budget + this.carryRx) {
            this.carryRx += budget
            rx += budget
            budget = 0
            rxDone = true
            // debug('RXDEQUE', 'carry')
          } else {
            n -= this.carryRx
            this.carryRx = 0
            budget -= n
            rx += n
            const { data, callback } = this.bufferA.shift()
            this.push(data)
            callback(null)
            // debug('RXDEQUE', 'this.push:', data)
          }
        }
      }

      // Process transmits
      if (!txDone) {
        if (this.bufferB.isEmpty()) {
          // debug('TXDEQUE', 'empty')
          txDone = true
        } else if (this.bufferB.peek().data === null) {
          const { callback } = this.bufferB.shift()
          this.out.push(null)
          txDone = true
          this.finishedB = true
          callback(null)
          // debug('TXDEQUE', null)
        } else { // See comment below.
          let n = this.bufferB.peek().data.length
          if (n > budget + this.carryTx) {
            this.carryTx += budget
            tx += budget
            budget = 0
            txDone = true
            // debug('TXDEQUE', 'carry')
          } else {
            n -= this.carryTx
            this.carryTx = 0
            budget -= n
            tx += n
            const { data, callback } = this.bufferB.shift()
            this.out.push(data)
            callback(null)
            // debug('TXDEQUE', 'out.push:', data)
          }
        }
      }
    }

    this.rxBytes += rx
    this.txBytes += tx
    this.lastTick = iteration

    // not sure if needed, gut says yes
    summary.rx = rx
    summary.tx = tx

    return summary
  }

  autoPump (interval, onTick) {
    let itr = 0
    return new Promise((resolve, reject) => {
      this.once('error', reject)
      this.out.once('error', reject)
      const loop = () => {
        setTimeout(() => {
          const stat = this.tick(itr++, 1000)
          if (typeof onTick === 'function') onTick(stat)
          if (!stat.rxEnd || !stat.txEnd) {
            loop()
          } else {
            resolve(stat)
          }
        }, interval)
      }
      loop()
    })
  }
}

module.exports = BufferedThrottleStream
