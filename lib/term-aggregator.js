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
  console.log(`${clearEsc}____.-  H Y P E R - S I M U L A T O R  -.____`)
  console.log('====-------------------------------------====\n')
  console.log(`State: ${snap.state} Speed: ${snap.conf.speed}x Interval: ${snap.conf.interval}ms`)
  console.log(`Iteration: ${snap.iteration}\t\t SimTime: ${Math.floor(stats.time/1000)}s`)
  console.log(`Peers: ${peers.length}\t\t Pending: ${stats.pending}`)
  console.log(`Conn: ${links.length} \t\t Interconnection: ${stats.interconnection.toFixed(2)}`)
  console.log(`Swarm: ${pbw(stats.rate << 3)} / ${stats.load.toFixed(2)}`)

  {
    console.log('\nPeers')
    console.log('-------')
    for (const peer of peers.sort((a, b) => a.id < b.id)) {
      const state = peer.finished ? '-' :  'P'
      console.log(peer.id.toString(16).padStart(2, '0') +
      ` ${peer.name}`.padEnd(8) +
      state +
      ` conn: ${peer.connectionCount}/${peer.maxConnections}` +
      ` rate: ${pbw((peer.rx + peer.tx) << 3)}` +
      ` 🡓${pb(peer.rxTotal)} 🡑${pb(peer.txTotal)}`
      )
    }
    console.log('')
  }

  if (false) {
    console.log('\nConnections')
    console.log('-------')
    for (const l of links.sort((a,b) => a.id < b.id)) {
      const state = l.noop ? 'idle' : ( l.txEnd || l.rxEnd ? 'closing' : 'active')
      console.log(`${l.id}\t ${state} rate: ${(l.rx + l.tx) >> 8}KBps`)
    }
    console.log('')
  }

  if (Object.keys(custom)) {
    console.log('\nCustom events counts')
    console.log('----------------------')
    for (const name of Object.keys(custom)) {
      console.log(`'${name}'\t x${custom[name]}`)
    }
  }
  endl.unshift(endl.pop())
  console.log('\n')
  console.log(endl.join(''), '\n')
}
