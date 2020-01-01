const HyperSim = require('..')
const hypercore = require('hypercore')
const { randomBytes } = require('crypto')
const { keyPair } = require('hypercore-crypto')

const { publicKey, secretKey } = keyPair()

const nLeeches = 20
const nBlocks = 45

try {
  const simulator = new HyperSim({
    logger: HyperSim.TermMachine()
    // logger: () => {}
  })

  simulator.ready(() => {
    // Launch one seed.
    simulator.launch('seed', {
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
      simulator.launch('leech', {
        linkRate
      }, SimulatedPeer)
    }

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
    secretKey: name === 'seed' ? secretKey : null
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
    if (name === 'seed') end()
  }

  // setup content
  feed.ready(() => {
    if (name !== 'seed') {
      feed.on('download', (seq, chunk, peer) => {
        signal('download', { seq })
        // Ending conditions for a leech is to have all blocks
        if (feed.downloaded() === nBlocks) {
          end()
        }
      })
      feed.on('append', () => {
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
    /*
    ontick(v => {
      return { downloaded: feed.downloaded() }
    })*/
  })
}
