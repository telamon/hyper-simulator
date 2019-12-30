const test = require('tape')
const hypercore = require('hypercore')
const HyperSim = require('..')
const { defer } = require('deferinfer')

function noop () {}

test('Discovery & Transmission', async t => {
  t.plan(6)
  try {
    const sim = new HyperSim({
      logger: noop // line => console.error(JSON.stringify(line))
    })

    sim.launch(({ swarm, signal, name }, end) => {
      let pending = 1

      swarm.join(Buffer.from('stub-topic'), {
        lookup: false, // find & connect to peers
        announce: true // optional- announce self as a connection target
      })

      swarm.once('connection', (socket, details) => {
        t.pass('seed onConnection: ' + socket.id)
        socket.once('close', () => {
          // t.equal(detail.client, false, 'Initiating boolean available')
          if (!--pending) t.notOk(end(), 'Seed stream closed')
        })

        socket.on('data', chunk => {
          t.equal(chunk.toString(), 'hey seed', 'Leech msg received')
          socket.write('Yo leech!')
          socket.end()
        })
      })
    })

    sim.launch(({ swarm, signal, name }, end) => {
      swarm.join(Buffer.from('stub-topic'), {
        lookup: true, // find & connect to peers
        announce: true // optional- announce self as a connection target
      })
      swarm.once('connection', (socket, details) => {
        t.pass('leech onConnection ' + socket.id)
        socket.once('data', chunk => {
          t.equal(chunk.toString(), 'Yo leech!', 'Seed msg received')
          socket.end()
          // socket.destroy()
        })
        socket.once('close', () => {
          t.notOk(end(), 'Leech stream closed')
        })
        socket.write('hey seed')
      })
    })

    await sim.run(2, 100)
    t.end()
  } catch (err) { t.error(err) }
})

test('Basic hypercore simulation', async t => {
  t.plan(5)
  try {
    const sim = new HyperSim({
      logger: noop
      // logger: HyperSim.TermMachine()
      // logger: line => console.error(line)
    })

    await sim.ready()

    const initSeedFn = ({ storage, swarm }, end) => {
      return defer(done => {
        const feed = hypercore(storage)
        feed.ready(() => {
          feed.append('hello world!', err => {
            t.error(err)
            swarm.join(feed.key, { lookup: false })
            swarm.on('connection', (socket, { client }) => {
              socket
                .pipe(feed.replicate(client, { live: true }))
                .pipe(socket)
                .on('error', t.error)
            })
            end()
            done(null, feed)
          })
        })
      })
    }

    // Launch 1 nerfed seed
    const seedFeed = await sim.launch('seed',
      { linkSpeed: 50 * 1024, maxConnections: 1 },
      initSeedFn
    )

    // Launch 3 leeches
    for (let i = 0; i < 2; i++) {
      sim.launch('leech', ({ storage, swarm, signal }, end) => {
        const feed = hypercore(storage, seedFeed.key)
        feed.ready(() => {
          swarm.join(feed.key)
          swarm.on('connection', (socket, { client }) => {
            socket
              .pipe(feed.replicate(client, { live: true }))
              .pipe(socket)
              .on('error', t.error)
          })
          feed.get(0, (err, chunk) => {
            t.error(err)
            signal('msg-replicated')
            t.equal(chunk.toString('utf8'), 'hello world!', `Leech${i} done`)
            end()
          })
        })
      })
    }

    // Run the simulation
    await sim.run(2, 100)
  } catch (err) { t.error(err) }
  t.end()
})

/*
 * Debugging streamx-states, turns out that a writable.push(null)
 * manifests itself as the _final() callback. This of course
 * needed to be translated into a readable.push(null) when ducttaping
 * two duplex-streams together. Apologies for littering but i'm leaving
 * this here for future personal refernce:
 *
> protoStream._duplexState.toString(2).padStart(32,'0')
4333824
'00000000010000100010000100000000'
                   READ_DONE
> socket._duplexState.toString(2).padStart(32,'0')
13336848
'00000000110010111000000100010000'
                            Primary Read

> protoStream._duplexState
  .toString(2).split('').reverse().map((i,n) => parseInt(i) && n).filter(n => n)
[ 8,  // READ_PIPE_DRAINED
  13, // READ_DONE
  17, // WRITE_PRIMARY
  22  // WRITE_EMIT_DRAIN
]

> socket._duplexState.toString(2).split('').reverse().map((i,n) => parseInt(i) && n).filter(n => n)
[ 4, // READ_PRIMARY
  8, // READ_PIPE_DRAINED
  15,// READ_NEEDS_PUSH
  16,// WRITE_ACTIVE
  17,// WRITE_PRIMARY
  19,// WRITE_QUEUED
  22,// WRITE_EMIT_DRAIN
  23 // WRITE_NEXT_TICK (also assumes WRITE_ACTIVE)]

*/
