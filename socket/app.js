import { Server } from "socket.io";
import mediasoup from 'mediasoup'
import https from 'httpolyglot';
import fs from 'fs'

const options = {
  key: fs.readFileSync('./server/ssl/key.pem', 'utf-8'),
  cert: fs.readFileSync('./server/ssl/cert.pem', 'utf-8')
}

const httpsServer = https.createServer(options)
httpsServer.listen(4000, () => {
  console.log('listening on port: ' + 4000)
})
const io = new Server(httpsServer, {
  cors: {
    origin: "http://localhost:3000",
    methods: ["GET", "POST"],
    allowedHeaders: ["my-custom-header"],
    credentials: true
  },
});

// const connections = io.of('/mediasoup')

let worker
let rooms = {}          // { roomName1: { Router, rooms: [ sicketId1, ... ] }, ...}
let peers = {}          // { socketId1: { roomName1, socket, transports = [id1, id2,] }, producers = [id1, id2,] }, consumers = [id1, id2,], peerDetails }, ...}
let transports = []     // [ { socketId1, roomName1, transport, consumer }, ... ]
let producers = []      // [ { socketId1, roomName1, producer, }, ... ]
let consumers = []      // [ { socketId1, roomName1, consumer, }, ... ]


//! 가장 먼저해야 하는 작업 : worker를 생성하는 것 :-) worker가 있어야 router도 transport도 생성할 수 있다. 
const createWorker = async () => {
  worker = await mediasoup.createWorker({
    rtcMinPort: 2000,
    rtcMaxPort: 2100,
  })
  console.log(`worker pid ${worker.pid}`)

  worker.on('died', error => {
    // This implies something serious happened, so kill the application
    console.error('mediasoup worker has died')
    setTimeout(() => process.exit(1), 2000) // exit in 2 seconds
  })

  return worker
}

// We create a Worker as soon as our application starts
worker = createWorker()

const mediaCodecs = [
  {
    kind: 'audio',
    mimeType: 'audio/opus',
    clockRate: 48000,
    channels: 2,
  },
  {
    kind: 'video',
    mimeType: 'video/VP8',
    clockRate: 90000,
    parameters: {
      'x-google-start-bitrate': 1000,
    },
  },
]

io.on('connection', async socket => {
  // console.log(socket.id)
  
  socket.emit('connection-success', {
    socketId: socket.id,
  })

  //! 캔버스.js 관련 코드 시작 (연준)
  socket.on('object-added', data => {
    socket.broadcast.emit('new-add', data);
 })
 socket.on('imageobj-added', data => {
   socket.broadcast.emit('new-addimg', data);
})
 socket.on('path-added', data => {
   socket.broadcast.emit('new-addP', data);
})
 socket.on('object-modified', data => {
    socket.broadcast.emit('new-modification', data);
 })
 socket.on('object-deleted', data => {
   socket.broadcast.emit('deleteallcanvas', data);
 })
 socket.on('object-clear', data => {
   socket.broadcast.emit('clearcanvas', data);
 })
 //! 캔버스.js 관련 코드 시작 끝


  const removeItems = (items, socketId, type) => {
    items.forEach(item => {
      if (item.socketId === socket.id) {
        item[type].close()
      }
    })
    items = items.filter(item => item.socketId !== socket.id)

    return items
  }

  socket.on('disconnect', () => {
    // do some cleanup
    console.log('peer disconnected')
    consumers = removeItems(consumers, socket.id, 'consumer')
    producers = removeItems(producers, socket.id, 'producer')
    transports = removeItems(transports, socket.id, 'transport')

    try{
    console.log(peers[socket.id])
    const { roomName } = peers[socket.id]
    delete peers[socket.id]

    // remove socket from room
    rooms[roomName] = {
      router: rooms[roomName].router,
      peers: rooms[roomName].peers.filter(socketId => socketId !== socket.id)
    }
  }
  catch(e){
    
  }
  })

  socket.on('joinRoom', async (roomName, userName, callback) => {
    // create Router if it does not exist
    // const router1 = rooms[roomName] && rooms[roomName].get('data').router || await createRoom(roomName, socket.id)
    socket.join(roomName);
    const router1 = await createRoom(roomName, socket.id)
    
    peers[socket.id] = {
      socket,
      roomName,           // Name for the Router this Peer joined
      transports: [],
      producers: [],
      consumers: [],
      peerDetails: {
        name: userName,
        isAdmin: false,   // Is this Peer the Admin?
      }
    }
    
    console.log("🚀🚀🚀🚀", userName, peers[socket.id])
    // get Router RTP Capabilities
    const rtpCapabilities = router1.rtpCapabilities

    // call callback from the client and send back the rtpCapabilities
    callback({ rtpCapabilities })
  })

  socket.on("moveMove", (x,y,name) => {
    // console.log("monseMove!",x,y,name)
    // socket.emit()
  })
  const createRoom = async (roomName, socketId) => {
    // worker.createRouter(options)
    // options = { mediaCodecs, appData }
    // mediaCodecs -> defined above
    // appData -> custom application data - we are not supplying any
    // none of the two are required
    let router1
    let peers = []
    if (rooms[roomName]) {
      router1 = rooms[roomName].router
      peers = rooms[roomName].peers || []
    } else {
      router1 = await worker.createRouter({ mediaCodecs, })
    }
    
    console.log(`Router ID: ${router1.id}`, peers.length)

    rooms[roomName] = {
      router: router1,
      peers: [...peers, socketId],
    }

    return router1
  }

  // Client emits a request to create server side Transport
  // We need to differentiate between the producer and consumer transports
  socket.on('createWebRtcTransport', async ({ consumer }, callback) => {
    // get Room Name from Peer's properties
    const roomName = peers[socket.id].roomName

    // get Router (Room) object this peer is in based on RoomName
    const router = rooms[roomName].router

    createWebRtcTransport(router).then(
      transport => {
        callback({
          params: {
            id: transport.id,
            iceParameters: transport.iceParameters,
            iceCandidates: transport.iceCandidates,
            dtlsParameters: transport.dtlsParameters,
          }
        })

        // add transport to Peer's properties
        addTransport(transport, roomName, consumer)
      },
      error => {
        console.log(error)
      })
  })

  const addTransport = (transport, roomName, consumer) => {

    transports = [
      ...transports,
      { socketId: socket.id, transport, roomName, consumer, }
    ]

    peers[socket.id] = {
      ...peers[socket.id],
      transports: [
        ...peers[socket.id].transports,
        transport.id,
      ]
    }
  }

  const addProducer = (producer, roomName) => {
    producers = [
      ...producers,
      { socketId: socket.id, producer, roomName, name: peers[socket.id].peerDetails.name}
    ]
    peers[socket.id] = {
      ...peers[socket.id],
      producers: [
        ...peers[socket.id].producers,
        producer.id
      ]
    }
  }

  const addConsumer = (consumer, roomName) => {
    // add the consumer to the consumers list
    consumers = [
      ...consumers,
      { socketId: socket.id, consumer, roomName, }
    ]

    // add the consumer id to the peers list
    peers[socket.id] = {
      ...peers[socket.id],
      consumers: [
        ...peers[socket.id].consumers,
        consumer.id,
      ]
    }
  }
  
  socket.on('getProducers', callback => {
    //return all producer transports
    const { roomName } = peers[socket.id]
    const socketName = peers[socket.id].peerDetails.name

    let producerList = []
  
    producers.forEach(producerData => {
      if (producerData.socketId !== socket.id && producerData.roomName === roomName) {
        // console.log("🧐🧐", peers[producerData.socketId].peerDetails.name)
        producerList = [...producerList, [producerData.producer.id, peers[producerData.socketId].peerDetails.name]]
        
      }
    })

    // return the producer list back to the client
    callback(producerList)
  })

  const informConsumers = (roomName, socketId, id) => {
    console.log(`just joined, id ${id} ${roomName}, ${socketId}`)
    // A new producer just joined
    // let all consumers to consume this producer
    producers.forEach(producerData => {
      if (producerData.socketId !== socketId && producerData.roomName === roomName) {
        const producerSocket = peers[producerData.socketId].socket
        // use socket to send producer id to producer
        const socketName = peers[socketId].peerDetails.name
        //Todo: 아래 emit 인자 내용 달라짐 -> 컨트롤러에서 수정 필요 
        producerSocket.emit('new-producer', { producerId: id , socketName: socketName, socketId: socketId })
      }
    })
  }

  const getTransport = (socketId) => {
    const [producerTransport] = transports.filter(transport => transport.socketId === socketId && !transport.consumer)
    return producerTransport.transport
  }

  // see client's socket.emit('transport-connect', ...)
  socket.on('transport-connect', ({ dtlsParameters }) => {
    // console.log('DTLS PARAMS... ', { dtlsParameters })
    
    getTransport(socket.id).connect({ dtlsParameters })
  })

  // see client's socket.emit('transport-produce', ...)
  socket.on('transport-produce', async ({ kind, rtpParameters, appData }, callback) => {
    // call produce based on the prameters from the client
    const producer = await getTransport(socket.id).produce({
      kind,
      rtpParameters,
    })

    // add producer to the producers array
    const { roomName } = peers[socket.id]

    addProducer(producer, roomName)

    informConsumers(roomName, socket.id, producer.id)

    console.log('Producer ID: ', producer.id, producer.kind)

    producer.on('transportclose', () => {
      console.log('transport for this producer closed ')
      producer.close()
    })

    // Send back to the client the Producer's id
    callback({
      id: producer.id,
      producersExist: producers.length>1 ? true : false
    })
  })

  // see client's socket.emit('transport-recv-connect', ...)
  socket.on('transport-recv-connect', async ({ dtlsParameters, serverConsumerTransportId }) => {
    console.log(`DTLS PARAMS: ${dtlsParameters}`)
    const consumerTransport = transports.find(transportData => (
      transportData.consumer && transportData.transport.id == serverConsumerTransportId
    )).transport
    await consumerTransport.connect({ dtlsParameters })
  })

  socket.on('consume', async ({ rtpCapabilities, remoteProducerId, serverConsumerTransportId }, callback) => {
    try {

      const { roomName } = peers[socket.id]
      const  userName  = peers[socket.id].peerDetails.name
      // console.log("userName! 🎉🎉🎉🎉", userName)


      const router = rooms[roomName].router
      
      let consumerTransport = transports.find(transportData => (
        transportData.consumer && transportData.transport.id == serverConsumerTransportId
      )).transport

      // check if the router can consume the specified producer
      

      if (router.canConsume({
        producerId: remoteProducerId,
        rtpCapabilities
      })) {
        // transport can now consume and return a consumer
        const consumer = await consumerTransport.consume({
          producerId: remoteProducerId,
          rtpCapabilities,
          paused: true,  //! 공식문서에서 이를 권고. (index.js 에서 마지막에 consumer-resume emit 해 줌 )
          // 연결(?)이 끝나면(?) 그때 resume 하라고 공식문서에서 권고 -> consumer-resume 함수에서 resume 함
        })

        consumer.on('transportclose', () => {
          console.log('transport close from consumer')
        })

        consumer.on('producerclose', () => {
          console.log('producer of consumer closed')
          socket.emit('producer-closed', { remoteProducerId })

          consumerTransport.close([])
          transports = transports.filter(transportData => transportData.transport.id !== consumerTransport.id)
          consumer.close()
          consumers = consumers.filter(consumerData => consumerData.consumer.id !== consumer.id)
        })

        addConsumer(consumer, roomName)

        // from the consumer extract the following params
        // to send back to the Client
        const params = {
          id: consumer.id,
          producerId: remoteProducerId,
          kind: consumer.kind,
          rtpParameters: consumer.rtpParameters,
          serverConsumerId: consumer.id,
          userName:userName,  //!!!!!
        }

        // send the parameters to the client
        callback({ params })
      }
    } catch (error) {
      console.log(error.message)
      callback({
        params: {
          error: error
        }
      })
    }
  })

  socket.on('consumer-resume', async ({ serverConsumerId }) => {
    console.log('consumer resume')
    const { consumer } = consumers.find(consumerData => consumerData.consumer.id === serverConsumerId)
    await consumer.resume()
  })

  //!!!!!! 유나 합친 부분 (01/14)
  socket.on('video-out', async({socketId , off}) =>{
    const studentSocket = peers[socketId].socket
    studentSocket.emit('student-video-controller', {off : off})
    console.log( "🙊🙊🙊🙊🙊VIDEO" + socketId, off )
    // producerSocket.emit('new-producer', { producerId: id, socketId : socketId })
  }) 

  socket.on('audio-out', async({socketId, off}) =>{
    console.log( "🙊🙊🙊🙊🙊AUDIO" + socketId, off )
    studentSocket.emit('student-audio-controller', {off : off})
  })

})

const createWebRtcTransport = async (router) => {
  return new Promise(async (resolve, reject) => {
    try {
      // https://mediasoup.org/documentation/v3/mediasoup/api/#WebRtcTransportOptions
      const webRtcTransport_options = {
        listenIps: [
          {
            ip: '127.0.0.1', //!!!! replace with relevant IP address
            // announcedIp: '10.0.0.141',
          }
        ],
        enableUdp: true,
        enableTcp: true,
        preferUdp: true,
      }

      // https://mediasoup.org/documentation/v3/mediasoup/api/#router-createWebRtcTransport
      let transport = await router.createWebRtcTransport(webRtcTransport_options)
      console.log(`transport id: ${transport.id}`)

      transport.on('dtlsstatechange', dtlsState => {
        if (dtlsState === 'closed') {
          transport.close()
        }
      })

      transport.on('close', () => {
        console.log('transport closed')
      })

      resolve(transport)

    } catch (error) {
      reject(error)
    }
  })
}