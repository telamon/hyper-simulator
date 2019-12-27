const test = require('tape')
const hypercore = require('hypercore')
const ram = require('random-access-memory')
const { BufferedThrottleStream } = require('..')

test('Raw transfer, sanityCheck', t => {
  const sock = new BufferedThrottleStream({ id: 'DummySrc' }, { id: 'DummyDst' })
  let pending = 2

  const lseq = ['ett', 'två', 'tre', 'fyr', null]
  const rseq = ['alpha', 'bravo', 'gamma', 'delta', null]
  let li = 0
  let ri = 0
  sock.once('close', () => t.pass(`sock finished ${--pending}`))
  sock.out.once('close', () => t.pass(`sock.out finished ${--pending}`))

  sock.on('data', chunk => t.equal(chunk, rseq[ri++], `LMsg: ${chunk}`))
  sock.out.on('data', chunk => t.equal(chunk, lseq[li++], `RMsg: ${chunk}`))

  lseq.forEach(m => setTimeout(() => sock.write(m) &&
    m === lseq[lseq.length - 1] &&
    sock.end(), 100))
  rseq.forEach(m => setTimeout(() => sock.out.write(m) &&
    m === rseq[rseq.length - 1] &&
    sock.out.end(), 150))

  let itr = 0
  const loop = () => {
    if (!pending) {
      const { end } = sock.tick(itr++, 1000)
      t.ok(end)
      return t.end()
    }
    setTimeout(() => {
      const { rx, tx, end } = sock.tick(itr++, 1000)
      if (pending && end) t.notOk(pending)
      // console.log(rx, tx, end)
      loop()
    }, 100)
  }
  loop()
})

test('Hypercore replication', t => {
  const sock = new BufferedThrottleStream({ id: 'DummySrc' }, { id: 'DummyDst' })
  const feedA = hypercore(ram, null)
  let local = null
  let remote = null
  let pending = 5
  feedA.ready(() => {
    const feedB = hypercore(ram, feedA.key)
    feedA.append('a message', err => {
      t.error(err)
      feedB.ready(() => {
        local = feedA.replicate(true)
        remote = feedB.replicate(false)
        // local.on('close', () => { t.pass('close called'); --pending })
        // local.pipe(remote).pipe(local)
        feedB.get(0, (err, msg) => {
          t.error(err)
          t.equal(msg.toString(), 'a message', 'Message was replicated')
          --pending
        })
        sock.pipe(local, () => t.pass(`sock->local finished ${--pending}`))
          .pipe(sock, () => t.pass(`local->sock finished ${--pending}`))
        sock.out.pipe(remote, () => t.pass(`sock.out->local finished ${--pending}`))
          .pipe(sock.out, () => t.pass(`local->sock.out finished ${--pending}`))
      })
    })
  })

  const assertEnd = () => {
    t.end()
  }

  let itr = 0
  const loop = () => {
    if (!pending) return assertEnd()
    setTimeout(() => {
      const { rx, tx } = sock.tick(itr++, 1000)
      // console.log(rx, tx)
      loop()
    }, 100)
  }
  loop()
})

