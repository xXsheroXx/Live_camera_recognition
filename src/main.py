import json
import asyncio
import logging
from pathlib import Path
from contextlib import asynccontextmanager
from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from aiortc import RTCPeerConnection, RTCSessionDescription
from ultralytics import YOLO

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("livecam")

pcs = set()
tasks = set()
model = YOLO("yolov8n.pt")
BASE_DIR = Path(__file__).resolve().parent


@asynccontextmanager
async def lifespan(_app: FastAPI):
    try:
        logger.info("LiveCameraRecognition starting")
        yield
    finally:
        for task in list(tasks):
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)

        await asyncio.gather(*(pc.close() for pc in pcs), return_exceptions=True)
        pcs.clear()
        logger.info("LiveCameraRecognition shutdown complete")


app = FastAPI(lifespan=lifespan)
app.mount("/static", StaticFiles(directory=BASE_DIR / "static"), name="static")


@app.get("/")
async def index():
    html = (BASE_DIR / "static" / "index.html").read_text(encoding="utf-8")
    return HTMLResponse(html)


async def process_video(track, state):
    frame_queue = asyncio.Queue(maxsize=1)

    async def reader():
        while True:
            frame = await track.recv()
            if frame_queue.full():
                try:
                    frame_queue.get_nowait()
                except asyncio.QueueEmpty:
                    pass
            await frame_queue.put(frame)

    reader_task = asyncio.create_task(reader())

    try:
        while True:
            frame = await frame_queue.get()
            img = frame.to_ndarray(format="bgr24")

            results = model(img, verbose=False)
            r = results[0]

            detections = []
            if r.boxes is not None:
                boxes = r.boxes.xyxy.tolist()
                classes = r.boxes.cls.tolist()
                confidences = r.boxes.conf.tolist()

                for box, cls, conf in zip(boxes, classes, confidences):
                    x1, y1, x2, y2 = box
                    detections.append({
                        "label": r.names[int(cls)],
                        "confidence": float(conf),
                        "box": [x1, y1, x2, y2]
                    })

            channel = state.get("channel")
            if channel and channel.readyState == "open":
                channel.send(json.dumps({
                    "type": "detections",
                    "items": detections
                }))

            await asyncio.sleep(0.03)  # simple throttle
    finally:
        reader_task.cancel()
        await asyncio.gather(reader_task, return_exceptions=True)


@app.post("/offer")
async def offer(request: Request):
    params = await request.json()
    offer = RTCSessionDescription(sdp=params["sdp"], type=params["type"])

    pc = RTCPeerConnection()
    pcs.add(pc)

    state = {"channel": None, "channel_open": False}

    @pc.on("datachannel")
    def on_datachannel(channel):
        state["channel"] = channel
        logger.info("Data channel created")

        @channel.on("open")
        def on_open():
            state["channel_open"] = True
            logger.info("Data channel open")

        @channel.on("close")
        def on_close():
            state["channel_open"] = False
            logger.info("Data channel closed")

    @pc.on("track")
    def on_track(track):
        if track.kind == "video":
            task = asyncio.create_task(process_video(track, state))
            tasks.add(task)
            task.add_done_callback(tasks.discard)

    await pc.setRemoteDescription(offer)
    answer = await pc.createAnswer()
    await pc.setLocalDescription(answer)

    return JSONResponse({
        "sdp": pc.localDescription.sdp,
        "type": pc.localDescription.type
    })
