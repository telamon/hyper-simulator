const { BasicTimeline } = require('hypersim-parser')
const prettyBandwidth = require('prettybandwidth')
const pbw = n => prettyBandwidth(n).padStart(10)
const pb = require('pretty-bytes')
const clearEsc = '\033[2J'

module.exports = function SimpleTermAggregator () {
  const parser = new BasicTimeline({ binary: false })
  parser.on('snapshot', printSnapshot)

  parser.setReducer('custom', (v, ev, c, glob) => {
    if (ev.type !== 'custom') return glob.customCounts || {}
    if (!glob.customCounts) glob.customCounts = {}
    const counts = glob.customCounts
    if (!counts[ev.event]) counts[ev.event] = 0
    counts[ev.event]++
    return counts
  })

  // Total upload/download stats
  parser.pushReducer('peers', (v, ev, c, glob) => {
    if (ev.type !== 'peer' || ev.event !== 'tick') return v
    if (!glob.bwsum) glob.bwsum = {}
    if (!glob.bwsum[ev.id]) glob.bwsum[ev.id] = { rx: 0, tx: 0}
    glob.bwsum[ev.id].rx += ev.rx
    glob.bwsum[ev.id].tx += ev.tx
    c[ev.id].rxTotal = glob.bwsum[ev.id].rx
    c[ev.id].txTotal = glob.bwsum[ev.id].tx
    return v
  })

  return chunk => { parser.write(chunk) }
}
// let endl = Array.from(new Array(6)).map(() => '_.-\'"`-.').join('').split('')
 let endl = '====---------------========---------------===='.split('')
function printSnapshot (snap) {
  const { stats, peers, links, custom } = snap
  const buffer = []
  const log = (...args) => buffer.push(args)
  log(`${clearEsc}____.-  H Y P E R - S I M U L A T O R  -.____`)
  log('====-------------------------------------====\n')
  log(`State: ${snap.state} Speed: ${snap.conf.speed}x Interval: ${snap.conf.interval}ms`)
  log(`Iteration: ${snap.iteration}\t\t SimTime: ${Math.floor(stats.time/1000)}s`)
  log(`Peers: ${peers.length}\t\t Pending: ${stats.pending}`)
  log(`Conn: ${links.length} \t\t Interconnection: ${stats.interconnection.toFixed(2)}`)
  log(`Swarm: ${pbw(stats.rate << 3)} / ${stats.load.toFixed(2)}`)

  {
    log('\nPeers')
    log('-------')
    for (const peer of peers.sort((a, b) => a.id < b.id)) {
      const state = peer.finished ? '-' :  'P'
      log(peer.id.toString(16).padStart(2, '0') +
      ` ${peer.name}`.padEnd(8) +
      state +
      ` conn: ${peer.connectionCount}/${peer.maxConnections}` +
      ` rate: ${pbw((peer.rx + peer.tx) << 3)}` +
      ` 🡓${pb(peer.rxTotal)} 🡑${pb(peer.txTotal)}`
      )
    }
    log('')
  }

  if (false) {
    log('\nConnections')
    log('-------')
    for (const l of links.sort((a,b) => a.id < b.id)) {
      const state = l.noop ? 'idle' : ( l.txEnd || l.rxEnd ? 'closing' : 'active')
      log(`${l.id}\t ${state} rate: ${(l.rx + l.tx) >> 8}KBps`)
    }
    log('')
  }

  if (Object.keys(custom)) {
    log('\nCustom events counts')
    log('----------------------')
    for (const name of Object.keys(custom)) {
      log(`'${name}'\t x${custom[name]}`)
    }
  }
  endl.unshift(endl.pop())
  log('\n')
  log(endl.join(''), '\n')
  for (const line of buffer) console.log(...line)
}
