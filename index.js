// SPDX-License-Identifier: AGPL-3.0-or-later
const requireInject = require('require-inject')
const raf = require('random-access-file')
const { defer } = require('deferinfer')
const { mkdirSync, statSync } = require('fs')
const { join } = require('path')
const rimraf = require('rimraf')
const { EventEmitter } = require('events')
const BufferedThrottleStream = require('./lib/throttled-stream')
const sos = require('save-our-sanity')
const hyperswarm = require('hyperswarm')
const debug = require('debug')('hypersim')

const { NetworkResource } = requireInject('@hyperswarm/network', {
  net: sos({
    createServer: () => sos({
      on (ev, handler) { }
    }, 'net.createServer'),
    connect (port, host) {
      // TODO: if we wanna go the injection way then
      // this object that is returned here needs to be bound
      // to the peer. but at this point time we do not know which
      // peer.simnet it is that calls it.
      return sos({ on (ev, handler) { } }, 'net.connect')
    }
  }, 'net'),

  'utp-native': () => sos({
    on (ev, handler) { }
  }, 'utp-native')
})
// const { NetworkResource } = require('@hyperswarm/network')


const INIT = 'init'
const RUNNING = 'running'
const FINISHED = 'finished'

class SimulatedPeer {
  constructor (id, signal, opts = {}) {
    this.id = id
    this.name = opts.name
    this.linkRate = opts.linkRate || 102400
    this.latency = opts.latency || 100
    this.maxConnections = opts.maxConnections || 5
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
    return [this.src, this.dst].indexOf(peer) !== -1
  }

  connect (peer, callback) {
    if (this.isPoolFull || peer.isPoolFull) return callback(new Error('Connection Pool Exhausted'))
    // Maybe just return false and silently abort on already connected.
    if (this.isConnected(peer)) return callback(new Error('Already connected'))
    const socket = new BufferedThrottleStream()
    socket.id = `${sckCtr++}#${this.id}:${peer.id}`
    socket.src = this
    socket.dst = peer
    this._accept(socket, true)
    peer._accept(socket, false)
    return callback(null, socket)
  }

  tick (iteration, delta) {
    this.age++
    this.lastTick = iteration
    const { rx, tx } = this._consumed
    this._consumed = { rx: 0, tx: 0 }
    this._signal('tick', {
      rx,
      tx,
      maxConnections: this.maxConnections,
      connectionCount: this.sockets.length,
      linkRate: this.linkRate,
      load: (rx + tx) / (this.linkRate * delta / 1000),
      state: this.finished ? 'done' : 'active',
      age: this.age
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
    this._signal('end', { error })
  }

  _accept (socket, initiator) {
    if (this.isPoolFull) return false

    socket.once('close', () => {
      const idx = this.sockets.indexOf(socket)
      if (idx !== -1) this.sockets.splice(idx, 1)
      // this._signal('disconnect', {
      //   src: this.peer.id,
      //   dst: this.remotePeer.id,
      //   sid
      // })
    })

    this.sockets.push(socket)
    // this._signal(initiator ? 'connect' : 'accept', {
    //   src: this.peer.id,
    //   dst: remotePeer.id,
    //   sid: socket.id
    // })
    return true
  }

  bootstrap (storage, simnet, behaviour) {
    this.storage = storage
    this.behaviour = behaviour
    if (simnet) {
      this.simnet = simnet
      this.swarm = hyperswarm({ network: new SimulatedNetwork(simnet, this) })
    } else {
      this.swarm = hyperswarm() // this._swarm.boundInterface(peer), // TODO: alternatively support a real instance of hyperswarm
    }

    return defer(async done => {
      behaviour.initFn({
        ...behaviour,
        id: this.id,
        name: behaviour.name,
        storage,
        swarm: this.swarm,
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

class SimulatedNetwork extends NetworkResource {
  constructor (simnet, peer) {
    super({})
    this.simnet = simnet
    this.peer = peer
    const mockUTP = Object.assign(new EventEmitter(), {
      get maxConnections () { return peer.maxConnections },
      set maxConnections (v) { peer.maxConnections = v },
      send (buffer, offset, size, port, host) {
        // if (host === '__mockBootstrap')
      }
    })

    const mockTCP = Object.assign(new EventEmitter(), {
      get maxConnections () { return peer.maxConnections },
      set maxConnections (v) { peer.maxConnections = v },
      address () { return { address: `peer_${peer.id}`, port: peer.id } },
      connect (dst, handler, ...opts) {
        debugger
      }
    })

    this.tcp = sos(mockTCP, 'tcp-stack')
    this.utp = sos(mockUTP, 'utp-stack')
  }

  /* Simulated Discovery */
  get discovery () {
    const peer = this.peer
    const stub = {
      _domains: new Map(),
      _domain: k => k.slice(0, 20).toString() + '.hypersim',
      announce (topic, opts, callback) {
        // Peer is now discoverable
        console.log(`======= Peer ${peer.id} is discoverable on ${topic.toString()} =====`)
        // a stubbed topic object.
        return sos({
          on (ev, cb) {
            // 'peer' , on peer discovered
            // 'update' ???
            if (ev === 'update') debugger
            if (ev === 'peer') console.log(`======= Peer ${peer.id} lookups ${topic.toString()} =====`)
          }
        }, 'topic-handle')
      }
      /* lookup (topic, opts, callback) { } */
    }
    return sos(stub, 'discovery')
  }

  // writeprotect disco-sim
  set discovery (v) { }

  bind (port, callback) {
    if (typeof port === 'function') return this.bind(null, port)
    // Peer is connectable.
    console.log(`======= Peer ${this.peer.id} is listening/connectable =====`)
    this.simnet.listeningPeers[this.peer.id] = this.peer
    callback(null)
  }
}

let sckCtr = 0
class SimulatedSwarm {
  constructor (signal) {
    this.records = []
    this.listeningPeers = {}
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

  tick (iteration, deltaTime) {
    for (const record of this.records) {
      if (iteration <= record.lastTick + 1) continue
      for (const tkey of Object.keys(record.topics)) {
        const topic = record.topics[tkey]
        if (!topic.lookup) continue

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

  async close () {
    // TOOD: Not Implemented
  }
}

class Simulator extends EventEmitter {
  constructor (opts = {}) {
    super()
    this.poolPath = opts.poolPath || join(__dirname, '_cache')
    this._idCtr = 0
    this._logger = opts.logger || console.log
    this._swarmNetwork = new SimulatedSwarm(this._signal.bind(this))
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

    for (const behaviour of scenario) {
      for (let n = 0; n < behaviour.count; n++) {
        this.pending++
        const id = ++this._idCtr
        const storage = f => raf(join(this.poolPath, String(id), f))
        // TODO: implement random-access-metered
        const peer = new SimulatedPeer(id, this._signal.bind(this), behaviour)
        peer.bootstrap(storage, this._swarmNetwork, behaviour)
          .then(() => {
            this.peers.splice(this.peers.indexOf(peer), 1)
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

    this._swarmNetwork.tick(iteration, deltaTime) // if is hyperswarmSim

    const summary = {
      delta: deltaTime,
      pending: this.pending,
      connections: 0,
      peers: this.peers.length
    }

    let consumedBandwidth = 0
    const budgets = {}

    const swarmBandwidthCapacity = this.peers.reduce((sum, p) => {
      budgets[p.id] = p.linkRate * deltaTime / 1000
      return sum + budgets[p.id]
    }, 0)

    // Pump the simulated sockets
    for (const peer of this.peers) {
      for (const socket of peer.sockets) {
        const { src, dst } = socket
        if (socket.lastTick >= iteration) continue
        const budget = Math.min(budgets[src.id], budgets[dst.id])
        // We're simplifying budgets for sockets, treating them
        // as if they're all half-duplex.
        const { rx, tx } = socket.tick(iteration, budget)
        const load = (rx + tx) / budget
        this._signal('socket', 'tick', { id: socket.id, src: src.id, dst: dst.id, rx, tx, load })
        budgets[src.id] -= rx + tx
        budgets[dst.id] -= rx + tx
        consumedBandwidth += rx + tx
        src._inccon(rx, tx)
        dst._inccon(rx, tx)
        summary.connections++
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
    await this._swarmNetwork.close()
    await this._purgeStorage()
  }
}

module.exports = Simulator
module.exports.BufferedThrottleStream = BufferedThrottleStream
