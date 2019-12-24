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

class SimulatedPeer {
  constructor (id, signal, handlers = {}, opts = {}) {
    this.id = id
    this.name = opts.name
    this.linkRate = opts.linkRate || 102400
    this.latency = opts.latency || 100
    this.maxConnections = opts.maxConnections || 5
    this.sockets = []
    this.lastTick = 0
    this.age = 0
    this.finished = false
    this._signal = (ev, payload) => signal('peer', ev, {
      id,
      name: this.name,
      ...payload
    })
    this._signal('init', {})
  }

  isConnected (peer) {
    return [this.src, this.dst].indexOf(peer) !== -1
  }

  connect (peer, callback) {
    if (this.isPoolFull || peer.isPoolFull) return callback(new Error('Connection Pool Exhausted'))
    // Maybe just return false and silently abort on already connected.
    if (this.isConnected(peer)) return callback(new Error('Already connected'))
    const socket = new BufferedThrottleStream(this, peer)
    this._accept(socket, true)
    peer._accept(socket, false)
    return callback(null, socket)
  }

  tick (iteration, delta) {
    this.age++
    this.lastTick = iteration
  }

  get isPoolFull () {
    return !(this.sockets.length < this.maxConnections)
  }

  _end (error) {
    this.finished = true
    this._signal('end', { error })
  }

  _accept (socket, initiator) {
    if (this.isPoolFull) return false

    socket.once('close', () => {
      const idx = this.sockets.indexOf(socket)
      if (idx !== -1) this.sockets.splice(idx, 1)
      //this._signal('disconnect', {
      //  src: this.peer.id,
      //  dst: this.remotePeer.id,
      //  sid
      //})
    })

    this.sockets.push(socket)
    //this._signal(initiator ? 'connect' : 'accept', {
    //  src: this.peer.id,
    //  dst: remotePeer.id,
    //  sid: socket.id
    //})
    return true
  }
}

class BufferedThrottleStream extends Duplex {
  /**
   * @param linkRate {Number} - max allowed bytes per second (default: 1Mbit)
   * @param latency {Number} - Link latency in ms
   */
  constructor (src, dst, latency = 100) {
    super({
      write: (data, cb) => this.__write(true, data, cb),
      predestroy: () => { nextTick(() => this.out.destroyed || this.out.destroy()) }
    })
    this.id = `${src.id}:${dst.id}`
    this.src = src
    this.dst = dst

    this.lastTick = 0
    this.latency = latency
    this.rxBytes = 0
    this.txBytes = 0
    this.budgetRx = 0
    this.budgetTx = 0

    this.out = new Duplex({
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
      const s = dir ? this.out : this
      s.push(null)
      cb()
    } else {
      setTimeout(() => {
        const buffer = dir ? this.bufferB : this.bufferA
        buffer.push({ data, cb })
      }, this.latency)
    }
  }

  tick (iteration, deltaTime, bandwidthBudget) {
    // Process rx
    this.maxRate = 102400
    let rx = 0
    let tx = 0
    this.budgetRx += (deltaTime / 1000) * this.maxRate // TODO: use bandwidthBudget

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
      this.out.push(data)
      cb(null)
    }
    this.rxBytes += rx
    this.txBytes += tx
    return { rx, tx }
  }
}

class SimulatedSwarm {
  constructor (signal) {
    this.records = []
    this.connections = {}
    this.signal = signal
    this._discoverLimit = 5
    // this.addrSpace = { 43: Peer, 24: Peer }
  }

  register (record) {
    this.records.push(record)
  }

  _unregister (record) {
    const idx = this.records.indexOf(record)
    if (idx !== -1) this.records.splice(idx, 1)
  }

  _isConnected (a, b) {
    return !!(
      (this.connections[a.id] && this.connections[a.id][b.id]) ||
      (this.connections[b.id] && this.connections[b.id][a.id])
    )
  }

  tick (iteration, deltaTime) {
    for (const record of this.records) {
      if (iteration <= record.lastTick + 1) continue
      for (const tkey of Object.keys(record.topics)) {
        const topic = record.topics[tkey]
        // Find candidates
        this.records
          .filter(r => r !== record &&
            r.topics[tkey] &&
            r.topics[tkey].announce &&
            topic.candidates.indexOf(r.peer))
          .sort(() => Math.random() - 0.5) // shuffle
          .forEach((cr, i) => { // emit peer event
            if (record.maxDiscover <= i) return
            record.emit('peer', { record: cr, topic: Buffer.from(tkey), local: false })
          })
      }
      record.lastTick = iteration
    }
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

  boundInterface (peer) {
    const swarm = this
    const bound = Object.assign(new EventEmitter(), {
      peer: peer,
      lastTick: 0,
      maxDiscover: 3, // Per tick TODO: move this some where else.
      topics: {},

      join (topic, opts) {
        topic = topic.toString()
        this.topics[topic] = {
          announce: typeof opts.announce !== 'undefined' ? opts.announce : true,
          lookup: typeof opts.announce !== 'undefined' ? opts.lookup : true,
          candidates: []
        }
        swarm.register(this)
      },

      connect (candidate, callback) {
        this.peer.connect(candidate.record.peer, (err, socket) => {
          if (err) return callback(err)

          callback(null, socket, {
            client: true,
            peer: candidate.record.peer,
            type: 'simulated'
          })
        })
      },

      leave (topic) {
        delete this.topics[topic]
      }
    })

    bound.on('peer', can => {
      bound.topics[can.topic.toString()].candidates.push(can.record.peer)
      // crudely connect the peers if they don't already share
      // a connections
      if (bound.peer.isConnected(can.record.peer)) return
      bound.connect(can, (err, socket, details) => {
        if (err) return swarm._signal('connection-failed', err)
        bound.emit('connection', socket, details)
        can.record.emit('connection', socket.out, {
          client: false,
          peer: bound.peer,
          type: 'simulated'
        })
      })
    })

    return bound
  }
}

class Simulator {
  constructor (opts = {}) {
    this.poolPath = opts.poolPath || join(__dirname, '_cache')
    this._idCtr = 0
    this._logger = opts.logger || console.log
    this._swarm = new SimulatedSwarm(this._signal.bind(this))
    this.time = 0
    this.iteration = 0
    this.sessionId = new Date().getTime()
    this.pending = 0
    this.run = this.run.bind(this)
    this.peers = []
    this._transition(INIT, {
      swarm: 'hypersim'
    })
  }

  _transition (newState, ...extra) {
    this._signal('simulator', `state-${newState}`, ...extra)
    this._state = newState
  }

  async setup (scenario) {
    await this._purgeStorage()
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
        const peer = new SimulatedPeer(id, this._signal.bind(this), {
        }, role)
        let didEnd = false

        role.initFn({
          id,
          name: role.name,
          storage,
          swarm: this._swarm.boundInterface(peer), // TODO: alternatively support a real instance of hyperswarm
          signal: (ev, args) => {
            this._signal('custom', ev, { ...args, name: role.name, id })
          }
        }, err => {
          if (didEnd) return console.error('WARNING!: `end` invoked more than once by:', role.name, id)
          peer._end(err || null)
          this._swarm._destoyConnectionsOf(id)
          this.peers.splice(this.peers.indexOf(peer), 1)
          didEnd = true
          if (!--this.pending) this._transition(FINISHED)
        })
        this.peers.push(peer)
      }
    }
  }

  _signal (type, ev, payload = {}) {
    this._logger({
      type,
      event: ev,
      ...payload,
      time: this.time,
      iteration: this.iteration,
      sessionId: this.sessionId
    })
  }

  run (speed = 0.1, interval = 500) {
    this._transition(RUNNING, { speed, interval })
    return defer(async done => {
      let timeLastRun = new Date().getTime()
      while (this._state === RUNNING) {
        await defer(d => setTimeout(d, interval))
        const time = new Date().getTime()
        const deltaTime = (time - timeLastRun) * speed
        this._tick(deltaTime)
        timeLastRun = time
      }
      done()
    }).then(() => this.teardown())
  }

  _tick (deltaTime) {
    const iteration = ++this.iteration
    this.time += deltaTime

    this._swarm.tick(iteration, deltaTime) // if is hyperswarmSim
    const summary = {
      delta: deltaTime,
      pending: this.pending,
      connections: 0,
      peers: this.peers.length
    }

    let sumBand = 0

    // Pump the simulated sockets
    for (const peer of this.peers) {
      peer.tick(iteration, deltaTime)
      for (const socket of peer.sockets) {
        summary.connections++
        debugger
        const { rx, tx } = socket.tick(iteration, deltaTime)
        this._signal('socket', 'tick', { src: src.id, dst: dst.id, rx, tx })
        sumBand += rx + tx
      }
    }

    summary.rate = deltaTime ? Math.ceil(sumBand / (deltaTime / 1000)) : -1
    // TODO: add memory consumption to metrics
    this._signal('simulator', 'tick', summary)
  }

  _purgeStorage () {
    return defer(done => rimraf(this.poolPath, done))
  }

  async teardown () {
    await this._swarm.close()
    await this._purgeStorage()
  }
}
module.exports = Simulator
