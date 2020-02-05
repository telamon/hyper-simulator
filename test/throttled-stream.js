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
      const { rxEnd, txEnd } = sock.tick(itr++, 1000)
      t.ok(rxEnd && txEnd)
      return t.end()
    }
    setTimeout(() => {
      const { rxEnd, txEnd } = sock.tick(itr++, 1000)
      if (pending && (rxEnd && txEnd)) t.fail('Test still pending but socket reports end')
      else loop()
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
      sock.tick(itr++, 1000)
      // console.log(rx, tx)
      loop()
    }, 100)
  }
  loop()
})

test('Exit states: graceful both sides emit end()', t => {
  const sock = new BufferedThrottleStream({ id: 'DummySrc' }, { id: 'DummyDst' })
  sock.autoPump(100)
    .then(() => t.end(null))
    .catch(t.error)
  setTimeout(() => { sock.write('A ending'); sock.end() }, 200)
  setTimeout(() => { sock.out.write('B ending'); sock.out.end() }, 150)
})

test('Exit states: remote destroyed no error', t => {
  const sock = new BufferedThrottleStream({ id: 'DummySrc' }, { id: 'DummyDst' })
  sock.autoPump(100)
    .then(() => t.end(null))
    .catch(t.error)
  setTimeout(() => { sock.write('A ending') }, 200)
  setTimeout(() => { sock.out.write('B ending'); sock.out.destroy() }, 200)
})

test('Exit states: remote destroyed with error', t => {
  const sock = new BufferedThrottleStream({ id: 'DummySrc' }, { id: 'DummyDst' })
  sock.autoPump(100)
    .then(() => t.fail('Promise should not resolve'))
    .catch(err => {
      t.equal(err.message, 'bob')
      t.end()
    })
  setTimeout(() => { sock.write('A ending') }, 200)
  setTimeout(() => { sock.out.write('B ending'); sock.out.destroy(new Error('bob')) }, 200)
})
