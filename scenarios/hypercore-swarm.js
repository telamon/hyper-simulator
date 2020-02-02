const HyperSim = require('..')
const hypercore = require('hypercore')
const { randomBytes } = require('crypto')
const { keyPair } = require('hypercore-crypto')

const { publicKey, secretKey } = keyPair()

const nLeeches = 8
const nBlocks = 40
const SEED = 'Seed'
const LEECH = 'Leech'
try {
  const simulator = new HyperSim({
    // logger: HyperSim.TermMachine()
    // logger: () => {}
  })

  simulator.ready(() => {
    // Launch one seed.
    simulator.launch(SEED, {
      linkRate: 56 << 10
    }, SimulatedPeer)

    // Launch some leeches
    for (let i = 0; i < nLeeches; i++) {
      const linkRate = (() => {
        switch (i % 3) {
          case 0: return 2048 << 8
          case 1: return 1024 << 8
          case 2: return 512 << 8
        }
      })()
      simulator.launch(LEECH, {
        linkRate
      }, SimulatedPeer)
    }

    // Launch 3 more peers after the first 3 reported done to
    // measure saturated swarm speedup.
    let launchedExtra = false
    simulator.on('tick', (i, stat) => {
      if (!launchedExtra && stat.pending < 6) {
        launchedExtra = true
        for (let i = 0; i < nLeeches; i++) {
          simulator.launch(LEECH, {
            linkRate: 1024
          }, SimulatedPeer)
        }
      }
    })

    // Watch the data be replicated.
    simulator.run(3, 100)
      .then(() => console.error('Simulation finished'))
      .catch(err => console.error('Simulation failed', err))
  })
} catch (e) {
  console.error('Simulation failed', e)
}

function SimulatedPeer (context, end) {
  const { storage, swarm, signal, name, ontick } = context

  const feed = hypercore(storage, publicKey, {
    // Let only the seed have the secretKey
    secretKey: name === SEED ? secretKey : null
  })

  const setupSwarm = () => {
    swarm.join(Buffer.from('mTopic'))
    swarm.on('connection', (socket, details) => {
      const proto = feed.replicate(details.client, { live: true })
      socket
        .pipe(proto)
        .pipe(socket)
      socket.once('error', e => signal('sock-error', { error: e.message }))
      proto.once('error', e => signal('proto-error', { error: e.message }))
    })
    if (name === SEED) end()
  }

  // setup content
  feed.ready(() => {
    if (name !== SEED) {
      feed.on('download', (seq, chunk, peer) => {
        signal('download', { seq })
        // Ending conditions for a leech is to have all blocks
        if (feed.downloaded() === nBlocks) {
          end()
        }
      })
      setupSwarm()
    } else {
      let pendingInserts = nBlocks
      const appendRandom = () => {
        feed.append(randomBytes(512 << 8), err => {
          if (err) return end(err)
          signal('append', { seq: feed.length })
          if (!--pendingInserts) setupSwarm()
          else appendRandom()
        })
      }
      appendRandom()
    }

    ontick(v => {
      return { downloaded: feed.downloaded() }
    })
  })
}
