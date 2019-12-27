// SPDX-License-Identifier: AGPL-3.0-or-later
const { Duplex } = require('streamx')
const FIFO = require('fast-fifo')
function peekPatch () {
  return this.tail.buffer[this.tail.btm]
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
      final: cb => this._final(cb, true)
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

  _final (callback, remote) {
    this.__write(!remote, null, callback)
  }

  __write (dir, data, cb) {
    const buffer = dir ? this.bufferB : this.bufferA
    // debug(('ENQUEUE', dir ? 'TX' : 'RX', data)
    buffer.push(data)
    cb(null)
  }

  tick (iteration, budget) {
    let rx = 0
    let tx = 0

    if (this.finishedA && this.finishedB) return { rx, tx, end: true }
    if (iteration <= this.lastTick) return { rx, tx, end: false }

    let rxDone = false
    let txDone = false
    while (!rxDone || !txDone) {
      // Process receives
      if (!rxDone) {
        if (this.bufferA.isEmpty()) {
          // debug(('RXDEQUE', 'empty')
          rxDone = true
        } else if (this.bufferA.peek() === null) {
          this.bufferA.shift()
          this.push(null)
          rxDone = true
          this.finishedA = true
          // debug(('RXDEQUE', 'null')
        } else {
          let n = this.bufferA.peek().length
          if (n > budget + this.carryRx) {
            this.carryRx += budget
            rx += budget
            budget = 0
            rxDone = true
            // debug(('RXDEQUE', 'carry')
          } else {
            n -= this.carryRx
            this.carryRx = 0
            budget -= n
            rx += n
            const data = this.bufferA.shift()
            this.push(data)
            // debug(('RXDEQUE', 'this.push:', data.toString())
          }
        }
      }

      // Process transmits
      if (!txDone) {
        if (this.bufferB.isEmpty()) {
          // debug(('TXDEQUE', 'empty')
          txDone = true
        } else if (this.bufferB.peek() === null) {
          this.bufferB.shift()
          this.out.push(null)
          txDone = true
          this.finishedB = true
          // debug(('TXDEQUE', 'null')
        } else {
          let n = this.bufferB.peek().length
          if (n > budget + this.carryTx) {
            this.carryTx += budget
            tx += budget
            budget = 0
            txDone = true
            // debug(('TXDEQUE', 'carry')
          } else {
            n -= this.carryTx
            this.carryTx = 0
            budget -= n
            tx += n
            const data = this.bufferB.shift()
            this.out.push(data)
            // debug(('TXDEQUE', 'out.push:', data.toString())
          }
        }
      }
    }

    this.rxBytes += rx
    this.txBytes += tx
    this.lastTick = iteration
    return { rx, tx, end: false }
  }
}

module.exports = BufferedThrottleStream
