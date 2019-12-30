// SPDX-License-Identifier: AGPL-3.0-or-later
const raf = require('random-access-file')
const { defer } = require('deferinfer')
const { mkdirSync, statSync } = require('fs')
const { join } = require('path')
const rimraf = require('rimraf')
const { EventEmitter } = require('events')
const BufferedThrottleStream = require('./lib/throttled-stream')
const termAggregator = require('./lib/term-aggregator')
const sos = require('save-our-sanity')
const hyperswarm = require('hyperswarm')

const INIT = 'init'
const RUNNING = 'running'
const FINISHED = 'finished'

// Global socket counter
let sckCtr = 0

class SimulatedPeer {
  constructor (id, signal, opts = {}) {
    this.id = id
    this.name = opts.name
    this.linkRate = opts.linkRate || 102400
    this.latency = opts.latency || 100
    this.maxConnections = opts.maxConnections || 3
    this.sockets = []
    this.lastTick = 0
    this.age = 0
    this._consumed = { rx: 0, tx: 0 }
    this.finished = false
    this._signal = (ev, payload = {}) => signal('peer', ev, {
      id,
      name: this.name,
      ...payload
    })
    this._rootSignal = signal
    this._signal('init')
  }

  isConnected (peer) {
    for (const { src, dst } of this.sockets) {
      if (src.id === peer.id || dst.id === peer.id) return true
    }
    return false
  }

  connect (peer, callback) {
    if (this.isPoolFull || peer.isPoolFull) return callback(new Error('Connection Pool Exhausted'))
    // Maybe just return false and silently abort on already connected.
    if (this.isConnected(peer)) return callback(new Error('Already connected'))
    const socket = new BufferedThrottleStream()
    socket.id = `${sckCtr++}#${this.id}:${peer.id}`
    socket.src = this
    socket.dst = peer
    const x = this._accept(socket, true)
    const y = peer._accept(socket, false)
    if (!(x && y)) debugger // This shouldn't ever happen
    return callback(null, socket)
  }

  get hasSimSwarm () {
    return this.boundSwarm && this.boundSwarm.__HYPERSIM__
  }

  tick (iteration, delta) {
    this.age++
    this.lastTick = iteration

    const { rx, tx } = this._consumed
    this._consumed = { rx: 0, tx: 0 }

    // tick BoundSwarm
    if (this.hasSimSwarm) this.boundSwarm.tick(iteration, delta)

    // log Peer summary
    this._signal('tick', {
      rx,
      tx,
      maxConnections: this.maxConnections,
      connectionCount: this.sockets.length,
      linkRate: this.linkRate,
      load: (rx + tx) / (this.linkRate * delta / 1000),
      state: this.finished ? 'done' : 'active',
      age: this.age,
      finished: this.finished
    })
  }

  get isPoolFull () {
    return !(this.sockets.length < this.maxConnections)
  }

  _inccon (rx, tx) {
    this._consumed.rx += rx
    this._consumed.tx += tx
  }

  _end (error) {
    if (this.finished) return console.error('WARNING!: `end` invoked more than once by:', this.name, this.id)
    this.finished = true
    // TODO: unregister peer from simulator.
    // this.peers.splice(this.peers.indexOf(peer), 1)
    this._signal('end', { error })
  }

  _removeSocket (socket) {
    const idx = this.sockets.indexOf(socket)
    if (idx !== -1) this.sockets.splice(idx, 1)
    // this._signal('disconnect', {
    //   src: this.peer.id,
    //   dst: this.remotePeer.id,
    //   sid
    // })
  }

  _accept (socket, initiator) {
    if (this.isPoolFull) return false
    this.sockets.push(socket)
    return true
  }

  bootstrap (storage, simdht, behaviour) {
    this.storage = storage
    this.behaviour = behaviour
    if (simdht) {
      this.simdht = simdht
      this.boundSwarm = new BoundSwarm(simdht, this)
    } else {
      // Does this even work?
      this.boundSwarm = hyperswarm() // this._swarm.boundInterface(peer), // TODO: alternatively support a real instance of hyperswarm
    }

    return defer(async done => {
      behaviour.initFn({
        ...behaviour,
        id: this.id,
        name: behaviour.name,
        storage,
        swarm: this.boundSwarm,
        signal: (ev, args) => {
          this._rootSignal('custom', ev, { ...args, name: behaviour.name, id: this.id })
        }
      }, err => {
        this._end(err || null)
        // this._swarm._destoyConnectionsOf(id)
        done()
      })
    })
  }
}

class BoundSwarm extends EventEmitter {
  get __HYPERSIM__ () { return true }
  constructor (dht, peer) {
    super()
    this.dht = dht
    this.peer = peer
    this.topics = new Map()
    // Ambitious, but i'd also like to model dropping
    // connections mid-replicate and observe how that affects the swarm
    // finding out decentralized services perform in bad link conditions.
    this.connectFailureRate = 0
    this.lastLookup = 0
    this.peerQueue = []
    this.banned = []
    this.joinedTopics = []
    this.age = 0
  }

  topic (key) {
    this.topics.get(key)
  }

  tick (iteration, delta) {
    this.age += delta
    // Fetch new peers
    if (this.lookup && this.age - this.lastLookup > 1000) {
      this.queryLookup()
    }

    // Attempt to connect
    if (this.lookup &&
      this.peerQueue.length &&
      this.peer.sockets.length < this.peer.maxConnections) {
      const que = this.peerQueue
      this.peerQueue = []
      que.forEach(n => {
        if (this.age - n.lastAttempt > 5000) {
          n.lastAttempt = this.age
          const { peer } = n
          // Attempt to connect
          this.peer.connect(peer, (err, socket) => {
            if (err) return this.peerQueue.push(n)
            this.emit('connection', socket, { client: true })
            peer.boundSwarm.emit('connection', socket.out, { client: false })

            // this.peer.signal(initiator ? 'connect' : 'accept', {
            //   src: this.peer.id,
            //   dst: peer.id,
            //   sid: socket.id
            // })
          })
        } else if (--n.attempts) {
          this.peerQueue.push(n)
        } else this.banned.push(n.peer.id)
      })
    }
  }

  join (topic, { lookup, announce } = {}) {
    this.lookup = !(lookup === false)
    this.announce = !(announce === false)

    if (!this.lookup && !this.announce) throw new Error('At both lookup and announce can\'t be set to false')
    if (this.lookup) this.queryLookup()
    if (this.announce) this.doAnnounce(topic)
  }

  doAnnounce (topic) {
    this.joinedTopics.push(topic)
    this.dht.register(topic, this.peer)
  }

  queryLookup () {
    for (const topic of this.joinedTopics) {
      for (const cand of this.dht.getCandiates(topic)) {
        if (this.banned.indexOf(cand.id) === -1 &&
          cand.id !== this.peer.id) {
          this.peerQueue.push({
            lastAttempt: -20000,
            attempts: 10,
            peer: cand
          })
          this.emit('peer', cand)
        }
      }
    }
  }
}

class SimDHT {
  constructor (signal) {
    this.listeningPeers = {}
    this.signal = signal
  }

  register (topic, record) {
    topic = topic.toString()
    this.listeningPeers[topic] = this.listeningPeers[topic] || []
    this.listeningPeers[topic].push(record)
  }

  unregister (topic, record) {
    const records = this.listeningPeers[topic]
    const idx = records.indexOf(record)
    if (idx !== -1) records.splice(idx, 1)
  }

  getCandiates (topic) {
    return this.listeningPeers[topic]
      .sort(() => Math.random() - 0.5) // shuffle
  }

  tick (iteration, deltaTime) {
    // TODO: auto remove stale
  }

  async close () {
    // TOOD: Not Implemented
  }
}

class Simulator extends EventEmitter {
  constructor (opts = {}) {
    super()
    this.poolPath = opts.poolPath || join(__dirname, '_cache')
    this._idCtr = 0
    this._logger = opts.logger || termAggregator() || (msg => console.log(JSON.stringify(msg)))
    this._simdht = new SimDHT(this._signal.bind(this))
    this.time = 0
    this.iteration = 0
    this.sessionId = new Date().getTime()
    this.pending = 0
    this.run = this.run.bind(this)
    this.peers = []
    this._finishNextTick = false
    this.bwReserve = 10 << 8 // Minimum bandwidth for socket per tick 10KiloByte
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

    for (const behaviour of scenario) {
      for (let n = 0; n < behaviour.count; n++) {
        this.pending++
        const id = ++this._idCtr
        const storage = f => raf(join(this.poolPath, String(id), f))
        // TODO: implement random-access-metered
        const peer = new SimulatedPeer(id, this._signal.bind(this), behaviour)
        peer.bootstrap(storage, this._simdht, behaviour)
          .then(() => {
            if (!--this.pending) this._finishNextTick = true
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

  run (speed = 0.9, interval = 500) {
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
    if (this._finishNextTick) this._transition(FINISHED)
    const iteration = ++this.iteration
    this.time += deltaTime

    this._simdht.tick(iteration, deltaTime) // if is hyperswarmSim

    const summary = {
      state: this._state,
      delta: deltaTime,
      pending: this.pending,
      connections: 0,
      peers: this.peers.length
    }

    let consumedBandwidth = 0
    const budgets = {}

    const swarmBandwidthCapacity = this.peers.reduce((sum, p) => {
      const h = p.sockets.length * this.bwReserve
      budgets[p.id] = (p.linkRate - h) * deltaTime / 1000
      return sum + budgets[p.id]
    }, 0)

    // Pump the simulated sockets
    for (const peer of this.peers) {
      // Yep, we havea QoS issue, reserving bandwith is one way but
      // but each tick we exhaust the bandwith on the first socket..
      for (const socket of peer.sockets.sort(() => Math.random() - 0.5)) {
        const { src, dst } = socket
        if (socket.lastTick >= iteration) continue
        const budget = Math.max(this.bwReserve * deltaTime / 1000, Math.min(budgets[src.id], budgets[dst.id]))
        // We're simplifying budgets for sockets, treating them
        // as if they're all half-duplex.
        const stat = socket.tick(iteration, budget)
        const { rx, tx, noop, rxEnd, txEnd, destroyed } = stat
        if (rxEnd || destroyed) src._removeSocket(socket)
        if (txEnd || destroyed) dst._removeSocket(socket)
        if (!noop) summary.connections++
        const load = (rx + tx) / budget

        this._signal('socket', 'tick', {
          ...stat,
          id: socket.id,
          src: src.id,
          dst: dst.id,
          load
        })

        budgets[src.id] -= rx + tx
        budgets[dst.id] -= rx + tx
        consumedBandwidth += rx + tx
        src._inccon(rx, tx)
        dst._inccon(tx, rx)
      }
      peer.tick(iteration, deltaTime)
    }
    summary.capacity = swarmBandwidthCapacity
    summary.rate = deltaTime ? Math.ceil(consumedBandwidth / (deltaTime / 1000)) : -1
    if (swarmBandwidthCapacity > 0) summary.load = summary.rate / swarmBandwidthCapacity
    // TODO: add memory consumption to metrics
    this._signal('simulator', 'tick', summary)
    this.emit('tick', iteration, summary)
  }

  _purgeStorage () {
    return defer(done => rimraf(this.poolPath, done))
  }

  async teardown () {
    await this._simdht.close()
    await this._purgeStorage()
    /*
    for (const peer of this.peers) {
      await peer.close()
    } */
  }
}

module.exports = Simulator
module.exports.BufferedThrottleStream = BufferedThrottleStream
