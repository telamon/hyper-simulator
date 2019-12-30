const HyperSim = require('..')
const hypercore = require('hypercore')
const { randomBytes } = require('crypto')
const { keyPair } = require('hypercore-crypto')

const { publicKey, secretKey } = keyPair()

const nLeeches = 20
const nBlocks = 45

try {
  const simulation = new HyperSim({
    // logger: () => {},
  })

  simulation
    .setup([
      // Launch 1 seed with a link cap to 56KByte
      { name: 'seed', initFn: SimulatedPeer, count: 1, linkRate: 56 << 10 },
      { name: 'leech', initFn: SimulatedPeer, count: nLeeches, linkRate: 1024 << 8 }
    ])
    .then(() => simulation.run(2, 100))
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
        signal('ondownload', { seq: feed.length })
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
  })
}
