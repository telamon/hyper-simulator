const HyperSim = require('..')
const hypercore = require('hypercore')
const { randomBytes } = require('crypto')
const { keyPair } = require('hypercore-crypto')

const { publicKey, secretKey } = keyPair()

const nLeeches = 5
const nBlocks = 45

try {
  const simulation = new HyperSim()
  simulation
    .setup([
      // Launch 1 seed with a link cap to 56KBit
      { name: 'seed', initFn: SimulatedPeer, count: 1 }, // , linkRate: 56 << 8 },
      { name: 'leech', initFn: SimulatedPeer, count: nLeeches }
    ])
    .then(() => simulation.run(1, 200))
    .then(() => console.log('Simulation finished'))
    .catch(err => console.log('Simulation failed', err))
} catch (e) {
  console.log('Simulation failed', e)
}

function SimulatedPeer (opts, end) {
  const { storage, swarm, signal, name } = opts
  const feed = hypercore(storage, publicKey, {
    // Let only the seed have the secretKey
    secretKey: name === 'seed' ? secretKey : null
  })

  function setupSwarm () {
    swarm.join(Buffer.from('mTopic'), { announce: name !== 'leech' })
    swarm.once('connection', (socket, details) => {
      const protoStream = feed.replicate(details.client)
      socket.pipe(protoStream).pipe(socket)
    })
  }

  // setup content
  feed.ready(() => {
    if (name !== 'seed') {
      feed.on('append', () => {
        signal('block', { seq: feed.length })
        // Ending conditions for a leech is to have all blocks
        if (feed.length === nBlocks) end()
      })
      setupSwarm()
    } else {
      let pendingInserts = nBlocks
      const appendRandom = () => {
        feed.append(randomBytes(256), err => {
          if (err) return end(err)
          signal('append', { seq: feed.length })
          if (!--pendingInserts) setupSwarm()
          else appendRandom()
        })
      }
      appendRandom()
    }
  })
}
