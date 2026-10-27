import sys, subprocess, numpy as np, cv2
from audio_analysis import ffmpeg_exe
ff = ffmpeg_exe()
src = "C:/Users/synex/OneDrive/Desktop/HOODSFIELD AI/final/Loops/Enchanted_Paradise_loop_4s_1080p_v1_drift.mp4"
out = sys.argv[1]; W, H = 1920, 1080; w, h = 960, 540; Z = 1.025
raw = subprocess.run([ff,"-v","error","-i",src,"-f","rawvideo","-pix_fmt","rgb24","-"],capture_output=True).stdout
F = np.frombuffer(raw,np.uint8).reshape(-1,H,W,3); N = len(F); print(N,"frames")
g = np.stack([cv2.GaussianBlur(cv2.cvtColor(cv2.resize(f,(w,h),interpolation=cv2.INTER_AREA),cv2.COLOR_RGB2GRAY),(0,0),1.2) for f in F]).astype(np.float32)
M = np.tile(np.eye(2,3,dtype=np.float32),(N,1,1))      # maps plate coords -> frame coords (at 960 scale)
crit = (cv2.TERM_CRITERIA_EPS|cv2.TERM_CRITERIA_COUNT, 200, 1e-7)
def warp_small(i):
    return cv2.warpAffine(g[i], M[i], (w,h), flags=cv2.INTER_LINEAR|cv2.WARP_INVERSE_MAP, borderMode=cv2.BORDER_REPLICATE)
for it in range(4):
    al = np.stack([warp_small(i) for i in range(N)])
    plate = np.median(al,0).astype(np.float32)
    # ignore sparkles/moving water: pixels that deviate from the plate in many frames
    dev = np.abs(al-plate).mean(0); mask = (dev < np.percentile(dev,60)).astype(np.uint8)
    mask = cv2.erode(mask, np.ones((5,5),np.uint8))
    for i in range(N):
        Mi = M[i].copy()
        try:
            _, Mi = cv2.findTransformECC(plate, g[i], Mi, cv2.MOTION_AFFINE, crit, mask, 5)
        except cv2.error:
            pass
        M[i] = Mi
    sh = [np.abs(M[i,:,2]).max() for i in range(N)]
    print("iter",it,"max shift (960px)",round(max(sh),2))
M[:, :, :] = M  # keep
# gentle smoothing (circular, 3-tap) only to take out residual estimator noise
P = M.reshape(N,6)
Ps = np.stack([np.convolve(np.r_[P[-1,j],P[:,j],P[0,j]],[.25,.5,.25],mode="valid") for j in range(6)],1)
M2 = Ps.reshape(N,2,3)
# full-res: scale translation, compose with centred zoom
S = np.diag([2,2,1.0])
rd = None
wr = subprocess.Popen([ff,"-y","-v","error","-f","rawvideo","-pix_fmt","rgb24","-s",f"{W}x{H}","-r","24","-i","-","-c:v","libx264","-crf","17","-preset","slow","-bf","0","-g","240","-pix_fmt","yuv420p","-an",out],stdin=subprocess.PIPE)
cx, cy = (W-1)/2, (H-1)/2
Zm = np.array([[1/Z,0,cx-cx/Z],[0,1/Z,cy-cy/Z],[0,0,1]])   # output pixel -> source (zoom-in)
for i in range(N):
    A = np.vstack([M2[i],[0,0,1]]); A = S@A@np.linalg.inv(S)   # plate->frame at full res
    T = A@Zm                                                   # output -> frame
    o = cv2.warpAffine(F[i], T[:2].astype(np.float32), (W,H), flags=cv2.INTER_LANCZOS4|cv2.WARP_INVERSE_MAP, borderMode=cv2.BORDER_REPLICATE)
    wr.stdin.write(o.tobytes())
wr.stdin.close(); wr.wait(); print("written")
