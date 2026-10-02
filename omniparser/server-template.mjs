// 一键安装时写入数据目录的 OmniParser /parse 服务（Python）。
// 自包含推理：YOLO(icon_detect) + Florence-2(icon_caption)，复刻 OmniParser v2 流程，
// 暴露与插件约定一致的 POST /parse（返回 parsed_content_list）。
// 若你更熟悉官方 gradio，也可让 endpoint 指向官方服务，只要实现相同的 /parse 响应。

export const SERVER_PY = String.raw`# -*- coding: utf-8 -*-
import argparse, base64, io, os, sys, time

def _setup():
    import torch
    from PIL import Image
    from ultralytics import YOLO
    from transformers import AutoModelForCausalLM, AutoProcessor
    return torch, Image, YOLO, AutoModelForCausalLM, AutoProcessor

WEIGHTS_DIR = os.environ.get("OMNI_WEIGHTS_DIR", "weights")
DEVICE = "cuda" if os.environ.get("OMNI_FORCE_CPU", "") == "" else "cpu"

_torch = None
_detect = None
_cap_model = None
_cap_proc = None

def _load():
    global _torch, _detect, _cap_model, _cap_proc
    if _detect is not None:
        return
    torch, Image, YOLO, AutoModelForCausalLM, AutoProcessor = _setup()
    _torch = torch
    use_cuda = torch.cuda.is_available() and DEVICE == "cuda"
    dtype = torch.float16 if use_cuda else torch.float32
    detect_path = os.path.join(WEIGHTS_DIR, "icon_detect")
    detect_pt = os.path.join(detect_path, "model.pt")
    if not os.path.exists(detect_pt):
        # 兼容不同权重命名
        for name in ("best.pt", "model.safetensors"):
            cand = os.path.join(detect_path, name)
            if os.path.exists(cand):
                detect_pt = cand
                break
    _detect = YOLO(detect_path)
    cap_path = os.path.join(WEIGHTS_DIR, "icon_caption_florence")
    _cap_proc = AutoProcessor.from_pretrained(cap_path, trust_remote_code=True)
    _cap_model = AutoModelForCausalLM.from_pretrained(
        cap_path, trust_remote_code=True, torch_dtype=dtype
    ).to("cuda" if use_cuda else "cpu")
    _cap_model.eval()

def _florence(pil_crop, task):
    inputs = _cap_proc(text=task, images=pil_crop, return_tensors="pt")
    if next(_cap_model.parameters()).is_cuda:
        inputs = {k: v.to("cuda").half() if v.dtype == _torch.float32 else v.to("cuda") for k, v in inputs.items()}
    else:
        inputs = {k: v for k, v in inputs.items()}
    with _torch.no_grad():
        ids = _cap_model.generate(
            input_ids=inputs["input_ids"], pixel_values=inputs["pixel_values"],
            max_new_tokens=256, num_beams=3, do_sample=False
        )
    text = _cap_proc.batch_decode(ids, skip_special_tokens=False)[0]
    parsed = _cap_proc.post_process_generation(text, task=task, image_size=(pil_crop.height, pil_crop.width))
    return parsed.get(task, "")

def _caption(pil_crop):
    try:
        out = _florence(pil_crop, "<CAPTION>")
        if isinstance(out, dict):
            out = out.get("caption", "")
        return str(out).strip()
    except Exception:
        return ""

def parse_image(pil_img, conf=0.05):
    _load()
    w, h = pil_img.size
    results = _detect.predict(pil_img, conf=conf, verbose=False)
    boxes = []
    if results and results[0].boxes is not None:
        b = results[0].boxes
        for i in range(len(b)):
            x1, y1, x2, y2 = [float(v) for v in b.xyxy[i].tolist()]
            cls = int(b.cls[i].item())
            cf = float(b.conf[i].item())
            boxes.append((x1, y1, x2, y2, cls, cf))
    parsed_list = []
    for (x1, y1, x2, y2, cls, cf) in boxes:
        bw, bh = x2 - x1, y2 - y1
        area = bw * bh
        # 过滤异常大/小框（与 OmniParser 的清理一致，阈值按整图比例）
        if area <= 1e-3 * w * h or area >= w * h:
            continue
        crop = pil_img.crop((int(x1), int(y1), int(x2), int(y2)))
        # OmniParser icon_detect：0 通常为可交互 icon，1 为文本区域
        is_icon = cls == 0
        content = _caption(crop) if is_icon else _caption(crop)
        parsed_list.append({
            "type": "icon" if is_icon else "text",
            "bbox": [round(x1, 1), round(y1, 1), round(x2, 1), round(y2, 1)],
            "interactivity": bool(is_icon),
            "content": content,
            "confidence": round(cf, 3)
        })
    return parsed_list, {"width": w, "height": h}

def create_app():
    from fastapi import FastAPI, UploadFile, File, Form
    from fastapi.responses import JSONResponse
    app = FastAPI(title="SecAgent OmniParser")

    @app.get("/health")
    def health():
        return {"status": "ok", "time": int(time.time())}

    @app.post("/parse")
    async def parse(file: UploadFile = File(default=None), base64: str = Form(default=None)):
        from PIL import Image
        raw = b""
        if file is not None:
            raw = await file.read()
        elif base64:
            raw = base64.b64decode(base64.split(",")[-1])
        else:
            return JSONResponse({"error": "missing image"}, status_code=400)
        try:
            img = Image.open(io.BytesIO(raw)).convert("RGB")
            parsed_list, size = parse_image(img)
            return {"parsed_content_list": parsed_list, "image_size": size}
        except Exception as exc:  # 推理失败要回传错误，便于宿主自纠正
            return JSONResponse({"error": str(exc)}, status_code=500)

    return app

if __name__ == "__main__":
    import uvicorn
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()
    print("loading OmniParser models ...", flush=True)
    _load()
    print("models ready", flush=True)
    uvicorn.run(create_app(), host=args.host, port=args.port, log_level="warning")
`;
