# Models and where to get them

Hoodsfield never downloads model weights for you: they are large and each has its own licence. This table is generated from the same list the in-app **Model manager** uses (Create menu → Model manager), which also shows what is installed on your PC.

Put files in the matching folder inside your ComfyUI `models` folder. Models on another drive are fine: add that folder under Settings → ComfyUI & folders → Extra model folders.

## Flux 3 Klein (image, edit, inpaint)

| File | Required | Folder | Where to get it |
|---|---|---|---|
| Klein diffusion model (INT8) | yes | `diffusion_models/` | [Hugging Face](https://huggingface.co/black-forest-labs/flux-3-image-klein-comfy) |
| Klein VAE | yes | `vae/` | [Hugging Face](https://huggingface.co/black-forest-labs/flux-3-image-klein-comfy/resolve/main/vae/flux2-vae.safetensors) |
| Klein text encoder | yes | `text_encoders/ or clip/` | [Hugging Face](https://huggingface.co/black-forest-labs/flux-3-image-klein-comfy) |

## Wan 2.2 video (I2V / T2V / first-last / long shots)

| File | Required | Folder | Where to get it |
|---|---|---|---|
| I2V high-noise expert (GGUF) | yes | `diffusion_models/` | [Hugging Face](https://huggingface.co/QuantStack/Wan2.2-I2V-A14B-GGUF) |
| I2V low-noise expert (GGUF) | yes | `diffusion_models/` | [Hugging Face](https://huggingface.co/QuantStack/Wan2.2-I2V-A14B-GGUF) |
| Lightning 4-step LoRA (high) | yes | `loras/` | [Hugging Face](https://huggingface.co/Kijai/WanVideo_comfy) |
| Lightning 4-step LoRA (low) | yes | `loras/` | [Hugging Face](https://huggingface.co/Kijai/WanVideo_comfy) |
| UMT5 text encoder | yes | `text_encoders/` | [Hugging Face](https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged) |
| Wan VAE | yes | `vae/` | [Hugging Face](https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged) |

## LTX 2.3: video, motion control, lip-sync

| File | Required | Folder | Where to get it |
|---|---|---|---|
| LTX 2.3 22B transformer | yes | `diffusion_models/` | [Hugging Face](https://huggingface.co/Lightricks/LTX-2.3) |
| Union-Control IC-LoRA (motion control) | optional | `loras/` | [Hugging Face](https://huggingface.co/Lightricks/LTX-2.3-22b-IC-LoRA-Union-Control) |
| DubIt IC-LoRA (better lip-sync) | optional | `Accept the licence on Hugging Face first, then place in loras/` | [Hugging Face](https://huggingface.co/Lightricks/LTX-2.3-22b-IC-LoRA-DubIt) (accept the licence first) |
| LTX audio VAE | yes | `checkpoints/` | [Hugging Face](https://huggingface.co/Lightricks/LTX-2) |

## MiniMax H3 (music-video / TikTok engine)

| File | Required | Folder | Where to get it |
|---|---|---|---|
| H3 diffusion model | yes | `diffusion_models/` | see the model's own page |
| H3 video VAE (fp16) | yes | `vae/` | see the model's own page |

## Upscale, smoothing, background removal

| File | Required | Folder | Where to get it |
|---|---|---|---|
| Real-ESRGAN x4+ | yes | `upscale_models/` | [Hugging Face](https://huggingface.co/schwgHao/RealESRGAN_x4plus/resolve/main/RealESRGAN_x4plus.pth) |
| RIFE 4.9 (frame interpolation) | yes | `custom node rife folder` | see the model's own page |
| BiRefNet (background removal) | optional | `background_removal/` | [Hugging Face](https://huggingface.co/Comfy-Org/BiRefNet/resolve/main/background_removal/birefnet.safetensors) |
| InSwapper (face swap) | optional | `insightface/` | see the model's own page |

## Notes

- **MiniMax H3** is used in an INT8 build with a fp16 video VAE (the INT8 convrot VAE decodes black). Place the files where the table says.
- **Flux 3 / H3 INT8 files** need ComfyUI's INT8 support; if a model fails to load, check the setup check's node list.
- Face-swap is optional and currently depends on a ComfyUI node with a known NumPy compatibility problem, so treat it as experimental.
- Real-ESRGAN, RIFE and BiRefNet are small; the video models are tens of gigabytes. Check free disk space in the Model manager before downloading.
- `app/backend/face_models/face_detection_yunet_2023mar.onnx` is the small YuNet face detector from the OpenCV Zoo (MIT licence). It ships with the repo and is used for face-aware checks.
