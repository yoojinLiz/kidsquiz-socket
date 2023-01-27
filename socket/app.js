import { Server } from "socket.io";
import mediasoup from 'mediasoup'
import express from "express";
import dotenv from "dotenv"
dotenv.config()
import http from "http"; 

const app = express(); 
const httpServer = http.createServer(app); 
const PORT = 4000; 

// aws 헬스체크용 
app.get("/health", (req, res) => {
  res.status(200).send("OK");
});

const io = new Server(httpServer, {
    cors: {
      origin: "*",
      methods: ["GET", "POST"],
      allowedHeaders: ["my-custom-header"],
      credentials: true
    },
  });
  const connections = io.of('/sock')

  httpServer.listen(PORT, () => {
    console.log(`listening on port: ${PORT}`)
  })

let worker
let rooms = {}          // { roomName1: { Router, rooms: [ sicketId1, ... ] }, ...}
let peers = {}          // { socketId1: { roomName1, socket, transports = [id1, id2,] }, producers = [id1, id2,] }, consumers = [id1, id2,], peerDetails }, ...}
let transports = []     // [ { socketId1, roomName1, transport, consumer }, ... ]
let producers = []      // [ { socketId1, roomName1, producer, }, ... ]
let consumers = []      // [ { socketId1, roomName1, consumer, }, ... ]

/*
  peers= {
    소켓아이디 : {
      socket: 소켓 정보,
      roomName: 조인한 룸 이름(라우터 이름), 
      transport: [],
      producers: [],// 해당 소켓의 producer id들의 배열
      consumers: [],
      peerDetails: {
        name: 로컬 스토리지의 유저 이름,
        isAdmin: 선생님인지 아닌지 bool
      }
  }
*/

//! [커서]
let sequenceNumberByClient = new Map();
let cursorPositionsSaved = {};


const createWorker = async () => {
  worker = await mediasoup.createWorker({
    rtcMinPort: 2000,
    rtcMaxPort: 2100,
  })
  console.log(`worker pid ${worker.pid}`)

  // mediasoup 내장 함수. worker process 가 예상치 않게 끊겼을 때 'died' 이벤트가 emit된다
  worker.on('died', error => {
    // This implies something serious happened, so kill the application
    console.error('mediasoup worker has died')
    setTimeout(() => process.exit(1), 2000) // exit in 2 seconds
  })

  return worker
}

//! 가장 먼저해야 하는 작업 : worker 생성 :-) worker가 있어야 router도 transport도 생성할 수 있다.  
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

connections.on('connection', async socket => {
  socket.emit('connection-success', {
    socketId: socket.id,
  })

  //[커서] 클라이언트에서 마우스가 움직일 때마다 보내주는 마우스 좌표 정보 (data)
  socket.on('mousemove', (data) => {
    socket.broadcast.emit('mousemove', data, socket.id, socket.name);

    cursorPositionsSaved[socket.id] = data; // 소켓별 좌표 정보 갱신
  });  

  //[커서] 🐭 유나 : 마우스 테스트
  socket.on('mouseHidden', (data) => {
    console.log("테스트 중입니다.")
    socket.emit('studentMouseHidden')
    socket.to(data.roomName).emit('studentMouseHidden');
  })

  socket.on('mouseShow', (data) => {
    socket.emit('studentMouseShow')
    socket.to(data.roomName).emit('studentMouseShow');
  })

  //! [fabric] todo: 나중에 방에만 갈 수 있도록 수정 필요 
  socket.on('object-added', data => {
    // socket.broadcast.to(roomName).emit('new-add', data);
    socket.broadcast.emit('new-add', data);
  })
  socket.on('imageobj-added', data => {
  // socket.broadcast.emit('new-addimg', data);
  socket.broadcast.emit('new-addimg', data);
  })
  socket.on('path-added', data => {
  // socket.broadcast.emit('new-addP', data);
  socket.broadcast.emit('new-addP', data);
  })
  socket.on('object-modified', data => {
    // socket.broadcast.emit('new-modification', data);
    socket.broadcast.emit('new-modification', data);
  })
  socket.on('object-deleted', data => {
  // socket.broadcast.emit('deleteallcanvas', data);
  socket.broadcast.emit('deleteallcanvas', data);
  })
  socket.on('object-clear', data => {
  // socket.broadcast.emit('clearcanvas', data);
  socket.broadcast.emit('clearcanvas', data);
  })
  //! fabric.js 관련 코드 끝

  //! [퍼즐] 퍼즐.js 관련 코드 시작 
  socket.on('solveSign', () =>{   
    connections.emit('allsolve');
  })

  socket.on('sendPuzzleURL', data =>{
    // socket.broadcast.emit('puzzleStart', data);
    socket.broadcast.emit('puzzleStart', data);
  })

  socket.on('move-puzzle', data =>{
    // socket.broadcast.emit('movesinglepuzzle',data);
    socket.broadcast.emit('movesinglepuzzle',data);
  })

  socket.on('clickup-puzzle', data =>{
    // socket.broadcast.emit('solvedpuzzle', data);
    socket.broadcast.emit('solvedpuzzle', data);
  })
  //! 퍼즐.js 관련 코드 끝

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
    // 연결이 끊긴 socket 정리
    console.log('peer disconnected')
    consumers = removeItems(consumers, socket.id, 'consumer')
    producers = removeItems(producers, socket.id, 'producer')
    transports = removeItems(transports, socket.id, 'transport')

    try{
      const { roomName } = peers[socket.id]
      delete peers[socket.id]

    //rooms에서 해당 소켓 정보 삭제
    rooms[roomName] = {
      router: rooms[roomName].router,
      peers: rooms[roomName].peers.filter(socketId => socketId !== socket.id)
    }
    }
    catch(e){}
    })

  socket.on('joinRoom', async (roomName, userName, isHost, callback) => {
    // if (userName === "노유나") {
    //   console.log("유나인가: ", userName =="노유나", userName === "노유나")
    //   return ;
    // }
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
        isAdmin: isHost, 
      }
    }
    console.log(`${userName} just joined the Room `)
  
    // Router RTP Capabilities
    const rtpCapabilities = router1.rtpCapabilities

    // [커서]mouseStart 최초 시작 -> 현재 해당 방의 소켓 좌표들을 전달해준다 
    socket.emit('mouseStart', { message: 'mouseStart!', id: socket.id, cursorPositionsSaved: cursorPositionsSaved});
    const id = socket.id
    socket.name = userName
  
    //Initialize this client's sequence number
    sequenceNumberByClient.set(socket, 1);

    // call callback from the client and send back the rtpCapabilities
    callback({ rtpCapabilities })
  })


  const createRoom = async (roomName, socketId) => {
    let router1
    let peers = []
    if (rooms[roomName]) {
      router1 = rooms[roomName].router
      peers = rooms[roomName].peers || []
    } else {
      router1 = await worker.createRouter({ mediaCodecs, })
    }
    
    // console.log(`Router ID: ${router1.id}`, peers.length)

    rooms[roomName] = {
      router: router1,
      peers: [...peers, socketId],
    }

    return router1
  }

 // 클라이언트에서 서버측 transport를 생성하기 위해 요청할 때 emit 
  socket.on('createWebRtcTransport', async ({ consumer }, callback) => {
    
    if (!consumer) {
      console.log(socket.name, " producer로서 createWebRtcTransport 호출")  
    } else {
      console.log(socket.name, " consumer로서 createWebRtcTransport 호출")  
    }
  
    const roomName = peers[socket.id].roomName
    const router = rooms[roomName].router

    // [체크]
    const [verify] = transports.filter(transport => transport.socketId === socket.id && !transport.consumer)
    // console.log("🔥", verify)    

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

  const addTransport = async(transport, roomName, consumer) => {
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
      // { socketId: socket.id, producer, roomName, name: peers[socket.id].peerDetails.name}
      { socketId: socket.id, producer, roomName, name: socket.name, kind: producer.kind}
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
    consumers = [
      ...consumers,
      { socketId: socket.id, consumer, roomName, }
    ]

    peers[socket.id] = {
      ...peers[socket.id],
      consumers: [
        ...peers[socket.id].consumers,
        consumer.id,
      ]
    }
  }
  
  socket.on('getProducers', callback => {
    const { roomName } = peers[socket.id]
    const socketName = peers[socket.id].peerDetails.name
    let producerList = []
    
    producers.forEach(producerData => {
      if (producerData.socketId !== socket.id && producerData.roomName === roomName) {
        // console.log(`저는 ${socket.name}이고 producerName은 ${ peers[producerData.socketId].peerDetails.name} 이에요! `)
        producerList = [...producerList, [producerData.producer.id,  peers[producerData.socketId].peerDetails.name, producerData.socketId, peers[producerData.socketId].peerDetails.isAdmin]] 
        
      }
    })
    callback(producerList) // producerList를 담아서 클라이언트측 콜백함수 실행 
  })

  // 새로운 producer가 생긴 경우 new-producer 를 emit 해서 consume 할 수 있게 알려줌 
  const informConsumers = (roomName, socketId, id) => {
    
    producers.forEach(producerData => {
      if (producerData.socketId !== socketId && producerData.roomName === roomName) {
        const producerSocket = peers[producerData.socketId].socket
        // use socket to send producer id to producer
        const socketName = peers[socketId].peerDetails.name
        const isNewSocketHost = peers[socketId].peerDetails.isAdmin

        console.log(`new-producer emit! socketName: ${socketName}, producerId: ${id}, kind : ${producerData.kind}` )
        producerSocket.emit('new-producer', { producerId: id , socketName: socketName, socketId: socketId , isNewSocketHost})
      }
    })
  }
  const getTransport = (socketId) => {
    console.log("getTransport 에서 확인해보는 socketId. 이게 transports 상의 socketId와 같아야해", socketId)
    const [producerTransport] = transports.filter(transport => transport.socketId === socketId && !transport.consumer)
    try {
      return producerTransport.transport 
    } catch(e) {
      console.log(`getTransport 도중 에러 발생. details : ${e}`)
    }
  }
  let socketConnect = {} //socket 아이디가 key, value는 Bool
  let socketAudioProduce = {} // socket 아이디가 key, value는 Bool
  let socketVideoProduce = {} // socket 아이디가 key, value는 Bool

  socket.on('transport-connect', async({ dtlsParameters }) => {
    console.log(socket.id,"가 emit('transport-connect', ...) 🔥")
    if (getTransport(socket.id).dtlsState !== "connected" || getTransport(socket.id).dtlsState !== "connecting")  {
      try {
        // console.log("찍어나보자..", getTransport(socket.id).dtlsState)
        const tempTransport = getTransport(socket.id)
        if (tempTransport){
          if  (!socketConnect.socketId)
            tempTransport.connect({ dtlsParameters })  
            socketConnect.socketId = true;  //!임시
          console.log( tempTransport.dtlsState)
        }
        
      }
      catch(e) {
        console.log(`transport-connect 도중 에러 발생. details : ${e}`)
      }
    }
  })
 
  socket.on('transport-produce', async ({ kind, rtpParameters, appData, mysocket }, callback) => {
    

    if ( (kind =="audio" && !socketAudioProduce.id) || (kind =="video" && !socketVideoProduce.id)) {
      const producer = await getTransport(socket.id).produce({
        kind,
        rtpParameters,
      })
      const id= socket.id
      if (kind == "audio") {
          socketAudioProduce.id = true; 
      }
      if (kind == "video") {
        socketVideoProduce.id = true; 
      }

      console.log('Producer ID: ', producer.id, producer.kind)

      //todo: 아래 부분 callback 아래쪽으로 옮기고 테스트 
      const { roomName } = peers[socket.id]
      addProducer(producer, roomName)
      informConsumers(roomName, socket.id, producer.id)
      producer.on('transportclose', () => {
        console.log('transport for this producer closed ')
        producer.close()
      })
      callback({
        id: producer.id,
        producersExist: producers.length>1 ? true : false
      })
    }
  })

  socket.on('transport-recv-connect', async ({ dtlsParameters, serverConsumerTransportId }) => {
    const consumerTransport = transports.find(transportData => (
      transportData.consumer && transportData.transport.id == serverConsumerTransportId
    )).transport
   console.log("consumerTransport의 dtlsState 확인 🌼🌼🌼", consumerTransport.dtlsState)
   try {
    await consumerTransport.connect({ dtlsParameters })
   } catch(e) {console.log("transport-recv-connect", e)}
  })
  
  //! [캔버스 업데이트]
  socket.on("atarashimember", (newbeesocket, teacherSocket) => {
    socket.emit('newestmember', newbeesocket)
  })

  socket.on('canvasUpdate', (socketID, objs) => {
    socket.to(socketID).emit('canvassetnewuser', objs);
  })


  //![커서]
  socket.on("closeCursor", (socketIdLeaving)=> {
    delete cursorPositionsSaved.socketIdLeaving;
  })

  socket.on('consume', async ({ rtpCapabilities, remoteProducerId, serverConsumerTransportId }, callback) => {
    try {
      const { roomName } = peers[socket.id]
      const  userName  = peers[socket.id].peerDetails.name
      const router = rooms[roomName].router
      
      let consumerTransport = transports.find(transportData => (
        transportData.consumer && transportData.transport.id == serverConsumerTransportId
      )).transport

      if (router.canConsume({
        producerId: remoteProducerId,
        rtpCapabilities
      })) {
        // transport can now consume and return a consumer
        const consumer = await consumerTransport.consume({
          producerId: remoteProducerId,
          rtpCapabilities,
          paused: true,  //공식문서에서 권고하는 방식. 클라이언트에서 consumer-resume emit 할 때 resume
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
          userName:userName, 
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

  // [비디오, 오디오 제어]
  socket.on("video-out", ({studentSocketId, on}) =>{
    //소켓아이디와 같은 프로듀서를 찾아서 onOff를 전달
    socket.to(studentSocketId).emit('student-video-controller', {on})
  }) 

  socket.on("audio-out", ({studentSocketId, on}) =>{
    // console.log(studentSocketId  + "🙊 조용히 하세요")
    socket.to(studentSocketId).emit('student-audio-controller', {on})
  }) 
  
    socket.on("notifyAudio", (studentSocketId, on, hostBool) => {
      // console.log(`host값이 ${hostBool} ${studentSocketId}의 audio enabled 상태가 ${on} 이 되었음`)
      if (!hostBool) { socket.broadcast.emit("notifyAudio", studentSocketId, on, hostBool) }
    })
    socket.on("notifyVideo", (studentSocketId, on, hostBool) => {
      // console.log(`${studentSocketId}의 audio enabled 상태가 ${on} 이 되었음`)
      if (!hostBool) { socket.broadcast.emit("notifyVideo", studentSocketId, on, hostBool) }
    } )
  
  

  // [퀴즈]
  socket.on("startQuiz", (question, choice1, choice2, rightAnswer, socketId, callback) => {
    console.log("퀴즈")

    // const question = "다음 중 겨울 잠을 자는 동물은 어떤 동물일까요 ?"
    // const choice1 = "https://kidsquizbucket.s3.ap-northeast-2.amazonaws.com/upload/%E1%84%86%E1%85%AE%E1%86%AB%E1%84%8C%E1%85%A6+%E1%84%83%E1%85%A1%E1%84%85%E1%85%A1%E1%86%B7%E1%84%8C%E1%85%B1.png"
    // const choice2 = "https://kidsquizbucket.s3.ap-northeast-2.amazonaws.com/upload/%E1%84%86%E1%85%AE%E1%86%AB%E1%84%8C%E1%85%A6+%E1%84%90%E1%85%A9%E1%84%81%E1%85%B5+.jpeg"
    // const rightAnswer = 1
    callback(question, choice1, choice2, rightAnswer) //퀴즈를 시작하는 것은 항상 선생님! 

    socket.broadcast.emit("startQuiz", question, choice1, choice2, rightAnswer, socketId)
  } )

  socket.on("correct", (name, hostSocket)=> {
    socket.to(hostSocket).emit("correctNotice", name)
    // socket.broadcast.emit("correctNotice", name)
  })
  socket.on("wrong", (name, hostSocket)=>{
    socket.to(hostSocket).emit("wrongNotice", name)
    // socket.broadcast.emit("wrongNotice", name)
  })
  socket.on("finishQuiz", ()=>{
      socket.broadcast.emit("finishQuiz")
    }  
  ) //! 퀴즈 관련 코드 끝!
}) // ! socket connction 끝 

let listenip ;
let announceip ;
if (process.platform === "linux" ) {
   listenip = '10.0.0.49'
   announceip ='3.39.0.224'
}
else {
   listenip = "127.0.0.1"
   announceip = null 
}
console.log("🎧 listenip is : ", listenip)

const createWebRtcTransport = async (router) => {
  return new Promise(async (resolve, reject) => {
    try {
      const webRtcTransport_options = {
        listenIps: [
          {
            ip: listenip, //!!!! replace with relevant IP address
            announcedIp: announceip
          }
        ],
        enableUdp: true,
        enableTcp: true,
        preferUdp: true,
      }

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