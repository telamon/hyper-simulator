// SPDX-License-Identifier: AGPL-3.0-or-later
const raf = require('random-access-file')
const { defer } = require('deferinfer')
const { mkdirSync, statSync } = require('fs')
const { join } = require('path')
const { Duplex } = require('streamx')
const rimraf = require('rimraf')
const FIFO = require('fast-fifo')
const { EventEmitter } = require('events')
const { nextTick } = require('process')

const INIT = 'init'
const RUNNING = 'running'
const FINISHED = 'finished'

function peekPatch () {
  return this.tail.buffer[this.tail.btm]
}

class BufferedThrottleStream extends Duplex {
  /**
   * @param linkRate {Number} - max allowed bytes per second (default: 1Mbit)
   * @param latency {Number} - Link latency in ms
   */
  constructor (linkRate = 102400, latency = 100) {
    super({
      write: (data, cb) => this.__write(true, data, cb),
      predestroy: () => { nextTick(() => this.b.destroyed || this.b.destroy()) }
    })
    this.maxRate = linkRate
    this.latency = latency
    this.rxBytes = 0
    this.txBytes = 0
    this.budgetRx = 0
    this.budgetTx = 0

    this.b = new Duplex({
      write: (data, cb) => this.__write(false, data, cb),
      predestroy: () => { nextTick(() => this.destroyed || this.destroy()) }
    })
    this.bufferA = new FIFO()
    this.bufferB = new FIFO()
    // Monkey patch peek method.
    this.bufferA.peek = peekPatch.bind(this.bufferA)
    this.bufferB.peek = peekPatch.bind(this.bufferB)
  }

  __write (dir, data, cb) {
    if (data === null) {
      const s = dir ? this.b : this
      s.push(null)
      cb()
    } else {
      setTimeout(() => {
        const buffer = dir ? this.bufferB : this.bufferA
        buffer.push({ data, cb })
      }, this.latency)
    }
  }

  tick (deltaTime) {
    // if (!this.bufferA.isEmpty || !this.bufferB.isEmpty()) debugger
    // Process rx
    let rx = 0
    let tx = 0
    this.budgetRx += (deltaTime / 1000) * this.maxRate
    while (!this.bufferA.isEmpty() &&
      this.bufferA.peek().data.length < this.budgetRx) {
      const { data, cb } = this.bufferA.shift()
      if (this.budgetRx > this.maxRate) this.budgetRx = 0
      else this.budgetRx -= data.length
      rx += data.length
      this.push(data)
      cb(null)
    }

    // Process tx
    this.budgetTx += (deltaTime / 1000) * this.maxRate
    while (!this.bufferB.isEmpty() &&
      this.bufferB.peek().data.length < this.budgetTx) {
      const { data, cb } = this.bufferB.shift()
      if (this.budgetTx > this.maxRate) this.budgetTx = 0
      else this.budgetTx -= data.length
      tx += data.length
      this.b.push(data)
      cb(null)
    }
    this.rxBytes += rx
    this.txBytes += tx
    return { rx, tx }
  }
}

class HyperswarmSim {
  constructor (signal) {
    this.vdht = {}
    this.connections = {}
    this.signal = (type, ev, extras) => {
      signal(type, ev, { time: this.time, iteration: this.iteration, ...extras })
    }
    this.pending = 0
    this._discoverLimit = 5
    this.iteration = 0
    this.time = 0
  }

  join (topic, id, handler) {
    if (Buffer.isBuffer(topic)) topic = topic.toString('utf8')
    const vtable = this.vdht[topic] = this.vdht[topic] || []
    const vrecord = { id, handler }
    vtable.push(vrecord)
    return () => this._leave(topic, vrecord)
  }

  _leave (topic, vpeer) {
    this.vdht[topic] = this.vdht[topic].filter(i => i.id !== vpeer.id)
  }

  _isConnected (a, b) {
    return !!(
      (this.connections[a.id] && this.connections[a.id][b.id]) ||
      (this.connections[b.id] && this.connections[b.id][a.id])
    )
  }

  _simulatePeerConnection (src, dst, topic) {
    const sig = this.signal
    const streamId = `${src.id}:${dst.id}`
    sig('socket', 'open', { id: streamId, src: src.id, dst: dst.id, state: 'CONNECTING' })
    const stream = new BufferedThrottleStream()

    stream.once('close', () => {
      sig('socket', 'close', { id: streamId, src: src.id, dst: dst.id, state: 'DESTROYED' })
      delete this.connections[src.id][dst.id]
    })

    if (!this.connections[src.id]) this.connections[src.id] = {}
    this.connections[src.id][dst.id] = { id: streamId, stream, src, dst }

    src.handler({ stream: stream, initiating: true, leave: () => this.leave(topic, src) })
    dst.handler({ stream: stream.b, initiating: false, leave: () => this.leave(topic, dst) })
  }

  tick (deltaTime) {
    this.time += deltaTime
    this.iteration++
    const summary = {
      delta: deltaTime,
      pending: this.pending,
      connections: 0
    }

    // Discovery and connection initiation
    for (const topic of Object.keys(this.vdht)) {
      const peers = this.vdht[topic].sort(() => Math.random() - 0.5)
      let limit = this._discoverLimit
      for (const src of peers) {
        for (const dst of peers) {
          if (src === dst) continue
          if (!this._isConnected(src, dst)) {
            this._simulatePeerConnection(src, dst, topic)
            if (!--limit) break // end discovery connection limit reached
          }
        }
      }
    }

    let sumBand = 0
    // Pump the simulated sockets
    for (const v of Object.values(this.connections)) {
      for (const { stream, src, dst } of Object.values(v)) {
        summary.connections++
        const { rx, tx } = stream.tick(deltaTime)
        this.signal('socket', 'tick', { src: src.id, dst: dst.id, rx, tx })
        sumBand += rx + tx
      }
    }
    summary.rate = deltaTime ? Math.ceil(sumBand / (deltaTime / 1000)) : -1
    this.signal('simulator', 'tick', summary)
  }

  _destoyConnectionsOf (id) {
    if (!this.connections[id]) return
    for (const { stream } of Object.values(this.connections[id])) {
      if (!stream.destroyed) stream.destroy()
    }
  }

  async close () {
    for (const v of Object.values(this.connections)) {
      for (const { stream } of Object.values(v)) {
        if (!stream.destroyed) stream.destroy()
      }
    }
  }

  boundInterface (peerId) {
    const swarm = this
    const bound = Object.assign(new EventEmitter(), {
      id: peerId,
      topics: {},
      join (topic, opts) {
        this.topics[topic] = {
          announce: typeof opts.announce !== 'undefined' ? opts.announce : true,
          lookup: typeof opts.announce !== 'undefined' ? opts.lookup : true
        }
        // TODO: implement above options
        swarm.join(topic, this.id, ({ stream, initiating, leave }) => {
          this.emit('connection', stream, { client: initiating })
        })
      }
    })

    return bound
  }
}

class HyperSim {
  constructor (opts = {}) {
    this.poolPath = opts.poolPath || join(__dirname, '_cache')
    this._idCtr = 0
    this._logger = opts.logger || console.log
    this._swarm = new HyperswarmSim(this._signal.bind(this))
    this._transition(INIT, { swarm: 'hypersim' })
    this.run = this.run.bind(this)
  }

  _transition (newState, ...extra) {
    this._signal('simulator', `state-${newState}`, ...extra)
    this._state = newState
  }

  async setup (scenario) {
    await this.teardown()
    try {
      const stat = statSync(this.poolPath)
      if (!stat.isDirectory()) throw new Error(`Path already exists and is not a directory: ${this.poolPath}`)
      this._signal('simulator', 'using-cache', { path: this.poolPath })
    } catch (err) {
      if (err.code !== 'ENOENT') throw err
      mkdirSync(this.poolPath)
      this._signal('simulator', 'create-cache', { path: this.poolPath })
    }

    for (const role of scenario) {
      for (let n = 0; n < role.count; n++) {
        this.pending++
        const id = ++this._idCtr
        const storage = f => raf(join(this.poolPath, String(id), f))
        this._signal('peer', 'init', { name: role.name, id })
        let didEnd = false

        role.initFn({
          id,
          name: role.name,
          storage,
          swarm: this._swarm.boundInterface(id), // TODO: alternatively support a real instance of hyperswarm
          signal: (ev, args) => {
            this._signal('app', ev, { ...args, name: role.name, id })
          }
        }, err => {
          if (didEnd) return console.error('WARNING!: `end` invoked more than once by:', role.name, id)
          this._signal('peer', 'end', { name: role.name, id, error: err })
          this._swarm._destoyConnectionsOf(id)
          didEnd = true
          if (!--this.pending) this._transition(FINISHED)
        })
      }
    }
  }

  _signal (type, ev, payload) {
    this._logger({ type, event: ev, ...payload })
  }

  run (speed = 0.1, interval = 500) {
    this._transition(RUNNING, { speed, interval })
    return defer(async done => {
      let timeLastRun = new Date().getTime()
      while (this._state === RUNNING) {
        await defer(d => setTimeout(d, interval))
        const time = new Date().getTime()
        const deltaTime = (time - timeLastRun) * speed
        this._swarm.tick(deltaTime) // if is hyperswarmSim
        timeLastRun = time
      }
      done()
    }).then(() => this.teardown())
  }

  async teardown () {
    await this._swarm.close()
    await defer(done => rimraf(this.poolPath, done))
  }
}
module.exports = HyperSim
