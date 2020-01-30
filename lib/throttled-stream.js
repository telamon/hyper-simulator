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
    // Monkey patch peek method.
    this.bufferA.peek = peekPatch.bind(this.bufferA)
    this.bufferB.peek = peekPatch.bind(this.bufferB)
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

  __write (dir, data, cb) {
    const buffer = dir ? this.bufferB : this.bufferA
    // debug('ENQUEUE', dir ? 'TX' : 'RX', data)
    buffer.push(data)
    cb(null)
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
        } else if (this.bufferA.peek() === null) {
          this.bufferA.shift()
          this.push(null)
          rxDone = true
          this.finishedA = true
          // debug('RXDEQUE', null)
        } else {
          if (this.bufferA.peek() === undefined) debugger // peek bug!
          let n = this.bufferA.peek().length
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
            const data = this.bufferA.shift()
            this.push(data)
            // debug('RXDEQUE', 'this.push:', data)
          }
        }
      }

      // Process transmits
      if (!txDone) {
        if (this.bufferB.isEmpty()) {
          // debug('TXDEQUE', 'empty')
          txDone = true
        } else if (this.bufferB.peek() === null) {
          this.bufferB.shift()
          this.out.push(null)
          txDone = true
          this.finishedB = true
          // debug('TXDEQUE', null)
        } else { // See comment below.
          // Ok there's something wierd here, I've verified that
          // we're never pushing any 'undefined' values to FIFO-buffers
          // but for some reason the buffer reports buffer.isEmpty() === true and
          // doing a buffer.shift() operation return `undefined` with just
          // more undefined values enqueued after it.
          // Is this a false-positive bug in fast-fifo?
          if (this.bufferB.peek() === undefined) debugger

          let n = this.bufferB.peek().length
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
            const data = this.bufferB.shift()
            this.out.push(data)
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
