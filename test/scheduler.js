const test = require('tape')

const Scheduler = require('../lib/scheduler')

test('enque && tick', t => {
  t.plan(5)
  const s = new Scheduler()
  let n = 0
  s.enque(5, () => t.equals(++n, 2, 'Second'))
  s.enque(3, () => t.equals(++n, 1, 'First'))
  s.enque(15, () => { t.equals(++n, 4, 'Fourth'); t.end() })
  s.enque(7, () => t.equals(++n, 3, 'Third'))

  t.equals(s.toArray().map(i => i.at).join(','), '3,5,7,15')
  let i = 0
  while (!s.empty) s.tick(i++)
})

test('cancel', t => {
  t.plan(4)
  const s = new Scheduler(false)
  let n = 0
  s.enque(2, () => t.equals(++n, 1, 'First'))
  const cancel = s.enque(4, t.fail.bind(null, 'Should have been canceled'))
  s.enque(13, () => t.equals(++n, 3, 'Third'))
  s.enque(5, () => t.equals(++n, 2, 'Second'))
  cancel()

  t.equals(s.toArray().map(i => i.at).join(','), '2,5,13')
  let i = 0
  while (!s.empty) s.tick(i++)
})
