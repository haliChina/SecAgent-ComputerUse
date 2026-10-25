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

def _strip_repo_prefix(value):
    # "microsoft/Florence-2-base-ft--configuration_florence2.Florence2Config"
    #   -> "configuration_florence2.Florence2Config"（按本地目录解析）
    # 仅当 head 形如 owner/repo 且 tail 是 module.Class 时才剥，避免误伤。
    if isinstance(value, str) and "--" in value:
        head, _, tail = value.partition("--")
        if "/" in head and "." in tail:
            return tail
    if isinstance(value, list):
        return [_strip_repo_prefix(v) for v in value]
    if isinstance(value, dict):
        return {k: _strip_repo_prefix(v) for k, v in value.items()}
    return value

def _patch_local_automap():
    # 实机：OmniParser 仓 icon_caption/config.json 的 auto_map 带
    # "microsoft/Florence-2-base-ft--" 前缀——transformers 见前缀就去线上仓库
    # 拉 configuration_florence2.py（经 HF_ENDPOINT 到 modelscope），连不上即崩，
    # 而本地 3 个 remote code .py 明明就在旁边。剥掉前缀后按本地目录解析，
    # 完全离线加载。幂等：无前缀时不改写文件。
    import json
    base = os.path.join(WEIGHTS_DIR, "icon_caption_florence")
    for name in ("config.json", "preprocessor_config.json", "tokenizer_config.json"):
        p = os.path.join(base, name)
        if not os.path.isfile(p):
            continue
        try:
            with open(p, "r", encoding="utf-8") as f:
                data = json.load(f)
            automap = data.get("auto_map")
            if not isinstance(automap, dict):
                continue
            stripped = {k: _strip_repo_prefix(v) for k, v in automap.items()}
            if stripped != automap:
                data["auto_map"] = stripped
                with open(p, "w", encoding="utf-8") as f:
                    json.dump(data, f, ensure_ascii=False, indent=2)
        except Exception:
            pass  # 配置不可读/不可写不挡启动，交给后续报错分诊

_AUTH = {"token": None}
_SELF_CHECK = {"ok": None, "error": None}

def _load():
    global _torch, _detect, _cap_model, _cap_proc
    if _detect is not None:
        return
    torch, Image, YOLO, AutoModelForCausalLM, AutoProcessor = _setup()
    _torch = torch
    use_cuda = torch.cuda.is_available() and DEVICE == "cuda"
    dtype = torch.float16 if use_cuda else torch.float32
    _patch_local_automap()
    detect_path = os.path.join(WEIGHTS_DIR, "icon_detect")
    detect_pt = os.path.join(detect_path, "model.pt")
    if not os.path.exists(detect_pt):
        # 兼容不同权重命名
        for name in ("best.pt", "model.safetensors"):
            cand = os.path.join(detect_path, name)
            if os.path.exists(cand):
                detect_pt = cand
                break
    # issue #18 问题 1：YOLO 必须拿权重文件路径——传目录是惰性构造，
    # 启动「假成功」，第一次 /parse 才在 predict 阶段 500。
    _detect = YOLO(detect_pt)
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
        # icon caption 的输出是一两个短语（OmniParser 官方即按 <CAPTION> 短描述使用）：
        # greedy + 32 token 足够，且 CPU 上比 beams=3/max_new_tokens=256 快一个数量级
        # （0.5.x 实机：beams=3×256 让 CPU 一屏几十个元素推理 >20s，客户端 20s 超时全部失败）。
        ids = _cap_model.generate(
            input_ids=inputs["input_ids"], pixel_values=inputs["pixel_values"],
            max_new_tokens=32, num_beams=1, do_sample=False
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
        # issue #18 附带：旧代码两分支相同（笔误）。文本块不需要 Florence
        # caption（icon 检测的 caption 语义只对 icon 有意义）——跳过它，
        # CPU 场景一屏几十个文本块的时间直接省掉。
        content = _caption(crop) if is_icon else ""
        parsed_list.append({
            "type": "icon" if is_icon else "text",
            "bbox": [round(x1, 1), round(y1, 1), round(x2, 1), round(y2, 1)],
            "interactivity": bool(is_icon),
            "content": content,
            "confidence": round(cf, 3)
        })
    return parsed_list, {"width": w, "height": h}

def create_app():
    from fastapi import FastAPI, Request, UploadFile, File, Form
    from fastapi.responses import JSONResponse
    app = FastAPI(title="SecAgent OmniParser")

    @app.get("/health")
    def health():
        return {"status": "ok", "time": int(time.time()), "selfcheck": dict(_SELF_CHECK)}

    @app.post("/parse")
    async def parse(request: Request, file: UploadFile = File(default=None), base64: str = Form(default=None)):
        if _AUTH["token"]:
            supplied = None
            try:
                supplied = request.headers.get("x-secagent-token") or request.query_params.get("token")
            except Exception:
                supplied = None
            if supplied != _AUTH["token"]:
                return JSONResponse({"error": "unauthorized"}, status_code=401)
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
    # 0.7.6：/parse 鉴权 token（manager 启动时随机生成经命令行传入；缺省=不鉴权，
    # 兼容用户自建的老服务）。/health 保持无鉴权（本机存活探测无敏感信息）。
    parser.add_argument("--token", default=None)
    args = parser.parse_args()
    _AUTH["token"] = args.token
    print("loading OmniParser models ...", flush=True)
    _load()
    # issue #18 问题 1：启动自检——最小图 predict 一次，把「加载假成功」当场暴露
    # （YOLO 传错路径这类惰性错误只有 predict 才炸）。自检失败不退出，/health
    # 带 selfcheck 结果供 doctor/manager 分诊。
    try:
        from PIL import Image as _Img
        _probe = _Img.new("RGB", (64, 64), (255, 255, 255))
        _detect.predict(_probe, verbose=False)
        _SELF_CHECK.update({"ok": True, "error": None})
        print("models ready (self-check ok)", flush=True)
    except Exception as _sc_err:
        _SELF_CHECK.update({"ok": False, "error": str(_sc_err)})
        print(f"SELF-CHECK FAILED: {_sc_err}", flush=True)
        print("models loaded but PREDICT WILL FAIL - see /health selfcheck", flush=True)
    uvicorn.run(create_app(), host=args.host, port=args.port, log_level="warning")
`;
