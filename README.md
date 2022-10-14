# hyper-simulator

[![JavaScript Style Guide](https://img.shields.io/badge/code_style-standard-brightgreen.svg)](https://standardjs.com)

> Swarm Integration Testing - because unit-tests for P2P sucks.

This project grew out of the frustration of always finding new and exotic bugs in production that were a complete pain to predict or reproduce with unit-tests.

- Hyper-simulator is not a replacement for your unit tests, you will still need them.
- Hyper-simulator is not be a replacement for your peers/friends, you still need them.

Write a scenario for your application and let it run for a couple of minutes.
If you did **NOT** uncover any new errors within 5 minutes of sim-time,
please file a [formal complaint](/decentstack/hyper-simulator/issues/new). ;)



The hacky-terminal output below is the built-in log-parser/visualizer that i've been using the past time.
I wish there was something more fancy, but everytime I run the simulator I find a higher priority issue
in the app that's being simulated...

So I guess the simulator does what it's supposed to do 🌟

Ping me on discord, happy to help / [@telamohn](https://discord.gg/8RMRUPZ9RS)


<details><summary><strong><a>How it works</a></strong> <sub>(Technical Details)</sub></summary>

> TL;DR; The simulator measures the virtual swarm and virtual peers, then logs each moment in sim-time as an `ndjson` event that can be analyzed and aggregated.


The whole simulation runs **offline** and _in-memory_.

It features a _simulated swarm_ and discovery process compatible with the `hyperswarm` API.

Each connection generated within the simulator is wrapped in a [ThrottledStream](https://github.com/decentstack/hyper-simulator/blob/master/lib/throttled-stream.js) that gives us control over data-transmission.

So the simulator runs in _iterations_ where each call to `sim.process(deltaTime)` generates a heartbeat/"tick"

It uses the same approach as many physics-based games, having a mainLoop that takes an amount of time as input which is used to fuel the calculations.

During each tick; we animate the simulated swarm, firing simulated `peer` and `connection` events,  and then pump all active ThrottledStreams providing them with bandwidth calculated by the amount of bandwidth remaining between the two peers. (the `QoS` could use some improvement.)

Each such process iteration generates multiple `ndjson` messages.
The `signal` method is a helper to let peers in your scenario report their own log messages during the run. :) (your message automatically get stamped with the peer-id nothing special)

The resulting logfile can be analyzed offline or in realtime but given some custom signals it can tell you how your application will behave given a network of N-Peers.

The project arose as an alternative to organize 30 people to run `your_application@version` and ask them to shout when the desired objective is reached. :)

Anyway, let me know if you give it a test-run.

P.S.
The `storage` is convenient `random-access-file` wrapper that subpaths everything as `$PWD/.hypersim_cache/${peer.id}/${requested_path}`, the `_cache` folder gets deleted before and after each run.
</details>

<br/>

Features a built-in realtime log-aggregator:

[![asciicast](https://asciinema.org/a/9AcikNnlS2UA8yR8eY3MFRi2R.svg)](https://asciinema.org/a/9AcikNnlS2UA8yR8eY3MFRi2R)

Related projects:
- [hypersim-parser](https://github.com/decentstack/hypersim-parser) Fast and memory efficient ndjson aggregator. (Starting point for log-parsing)
- ~~[hypersim-visualizer](https://github.com/decentstack/hypersim-visualizer) fancy Vue+D3.js visualizer.~~

## <a name="install"></a> Install

```bash
# with npm
npm i --save-dev hyper-simulator

# or with yarn
yarn add -D hyper-simulator

```

## <a name="usage"></a> Usage

Running from commandline:

```bash
# Run scenario and display the realtime stats in terminal
$(npm bin)/hypersim -T scenarios/myapp-scenario.js

# Run scenario and dump events to file
$(npm bin)/hypersim scenarios/myapp-scenario.js > swarm-log.json

# Run scenario and index all events in Elasticsearch
$(npm bin)/hypersim -e http://localhost:9200 scenario/myapp-scenario.js
```

### Defining a Scenario

Example scenario:
```js
const Simulator = require('hyper-simulator')

const sim = new Simulator()

await sim.ready() // Give the simulator some time to initialize

function MySeedSpawner() {
  // See peer-factory docs below.
}

function MyLeechSpawner() {
  // See peer-factory docs below.
}

// Launch 1 slow seed
sim.launch('seed',{ linkRate: 56<<8 }, MySeedSpawner())

// Launch 10 peers
for (let i = 0; i < 10; i++) {
  sim.launch('peer', MyLeechSpawner())
}

// Run simulation 1x speed and 200ms delay between ticks.
sim.run(1, 200)
  .then(() => console.error('Simulation finished'))
  .catch(err => console.error('Simulation failed', err)

// Simulator will run until manually stopped or all peers have signaled that they're done.
```

### Peer factory function

The launch interface is defined as followed:

#### `simulator.launch([name], [opts], initFn)`

- _optional_ **name** `String` tag the peer with a name or descriptor.
- _optional_ **opts** `Object` Launch options se below for defaults
- **intFn** `function(simContext, peerDone)` Peer factory function, see below
- **return** the result of `initFn` invocation.

Example opts:
```js
{
  name: 'anon',       // Tag peer with a name.
  linkRate: 102400,   // Maximum bandwidth in Bytes/Second
  maxConnections: 3,  // Maximum amount of active connections to maintain.
}
```

Example peer factory function:

```js
function SpawnPeer(context, peerDone) {
  // Destructure all values in context
  const {
    id,      // Uniquely generated id
    name,    // Name of peer as specified by launch()
    storage, // An instance of random-access-file,
    swarm,   // An instance of simulated hyperswarm
    opts,    // Copy of opts given to launch()
    signal,  // Function signal(eventName, payload) (more on this below)
    ontick,  // Lets you register a handler for peer.tick event: ontick(myHandlerFun)
    setTimeout, // Like vanilla setTimeout but uses simulated time instead.
    simulator // reference to the simulator.
  } = context

  // Initialize a decentralized feed or your application.
  const feed = hypercore(storage)

  // Find peers to replicate with
  feed.ready(() => {
    // Handle remote connections
    swarm.on('connection', (socket, { client }) => {
      socket
        .pipe(feed.replicate(client, { live: true }))
        .pipe(socket)
    })

    // Join the topic
    swarm.join(feed.key)
  })

  // Add custom signaling to the simulator output
  feed.on('download', seq => {
    signal('download', { seq })
  })

  // Attach peer.tick handler
  ontick(summary => {
    // Signal done when this peer has more than 5 blocks downloaded.
    if (feed.downloaded() > 5) peerDone()

    // Decorate the simulator peer#tick output with extra keys/values
    return { downloadedBlocks: feed.downloaded() }
  })
}

```

## Swarm-log

The following built-in events that are logged,

**Global keys**

All events will contain the following keys:

- **iteration** `{Number}` number of simulator ticks since start.
- **sessionId** `{Number}` Time/date at simulator initialization.
- **type** `{String}` Type of event
- **event** `{String}` Name of event
- **time** `{Number}` Amount of virtual milliseconds since simulator start.

#### simulator `state-initializing`

Emitted when simulator is instantiated

- **type** `simulator`
- **event** `state-initializing`
- **swarm** `hypersim|hyperswarm`


#### simulator `state-ready`

Emitted when simulator becomes ready

- **type** `simulator`
- **event** `state-ready`
- **swarm** `hypersim|hyperswarm`

#### simulator `state-running`
Emitted when simulator is started.
- **type** `simulator`
- **event** `state-running`
- **speed** `{number}` desc
- **interval** `{number}` desc

#### simulator `tick`

Emitted once on each tick

- **type** `simulator`
- **event** `tick`
- **state** `{string}` current state
- **delta** `{number}` virtual amount of milliseconds since previous tick.
- **pending** `{number}` Amount of non-finished peers in simulation.
- **connections** `{number}` Total amount of connections in swarm.
- **peers** `{number}` Amount of peers in swarm
- **capacity** `{number}` Sum of all peers' bandwidth
- **rate** `{number}` Sum of all peers' reported rate
- **load** `{number}` rate / capacity

#### simulator `state-finished`

Emitted once when all active peers have reached the 'done' or exited with an error.

- **type** `simulator`
- **event** `state-finished`


#### peer `init`

Emitted when a peer is launched

- **type** `peer`
- **event** `init`
- **id** `{number}` unique id of the peer.
- **name** `{string}` Peer name as provided during launch


#### peer `end`

Emitted when a peer has signaled being done or has thrown
an uncaught error.

- **type** `peer`
- **event** `end`
- **id** `{number}` unique id of the peer.
- **name** `{string}` Peer name as provided during launch
- **error** `{object}` null or the error that caused the peer to exit.

#### peer `tick`

Emitted by each peer every simulator tick.

- **type** `peer`
- **event** `tick`
- **id** `{number}` Unique peer id.
- **name** `{string}` Peer name
- **rx** `{number}` Number of bytes received during tick
- **tx** `{number}` Number of bytes transfered during tick
- **maxConnections** `{number}` Connection limit.
- **connectionCount** `{number}` Current connection count.
- **linkRate** `{number}` Bandwidth limit of peer.
- **load** `{number}` Bandwidth used during tick.
- **state** `{string}` State of peer. `active` or `done`
- **age** `{number}` Amount of ticks lived
- **finished** `{boolean}` true when peer signaled being done/ended.

#### socket `tick`

Emitted on each tick for each active connection in simulation.

- **type** `socket`
- **event** `tick`
- **rx** `{number}` Number of bytes received during tick
- **tx** `{number}` Number of bytes transfered during tick
- **noop** `{boolean}` true if no traffic occured during this tick
- **rxEnd** `{boolean}` receving end of socket is closed
- **txEnd** `{boolean}` transmitting end of socket is closed
- **rxDrained** `{boolean}` Receiving buffer not empty
- **txDrained** `{boolean}` Transmitting buffer not empty
- **id** `{string}` Unique id of socket
- **src** `{number}` Source peer id
- **dst** `{number}` Destination peer id
- **load** `{number}` (rx + tx) / Math.min(srcPeer.linkRate, dstPeer.linkRate)

#### custom

Emitted using the `signal` method provided by the peer launch interface.

- **type** `custom`
- **event** `{string}` The event name as signaled by application.
- **name** `{string}` Peer name that emitted the event
- **id** `{number}` Id of peer that emitted the event
- `YOUR CUSTOM METRICS`

## <a name="contribute"></a> Contributing

Ideas and contributions to the project are welcome. You must follow this [guideline](https://github.com/decentstack/hyper-simulator/blob/master/CONTRIBUTING.md).

## License

GNU AGPLv3 © Tony Ivanov

