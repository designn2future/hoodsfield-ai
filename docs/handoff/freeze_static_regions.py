import sys, subprocess, numpy as np, cv2
from audio_analysis import ffmpeg_exe
ff = ffmpeg_exe(); src, out = sys.argv[1], sys.argv[2]; W,H=1920,1080
raw = subprocess.run([ff,"-v","error","-i",src,"-f","rawvideo","-pix_fmt","rgb24","-"],capture_output=True).stdout
F = np.frombuffer(raw,np.uint8).reshape(-1,H,W,3); N=len(F)
plate = np.empty((H,W,3),np.float32)
for y in range(0,H,90): plate[y:y+90] = np.median(F[:,y:y+90].astype(np.float32),axis=0)
# how much does each pixel really change over the loop (luma, small blur to ignore grain)
L = np.stack([cv2.GaussianBlur(cv2.cvtColor(f,cv2.COLOR_RGB2GRAY).astype(np.float32),(0,0),1.5) for f in F])
dev = np.abs(L-np.median(L,0)).mean(0)
lo, hi = np.percentile(dev,45), np.percentile(dev,80)
m = np.clip((dev-lo)/(hi-lo),0,1); m = m*m*(3-2*m)
m = cv2.dilate(m,np.ones((9,9),np.uint8)); m = cv2.GaussianBlur(m,(0,0),7)[...,None]
print("moving fraction %.2f (lo %.2f hi %.2f)"%(m.mean(),lo,hi), flush=True)
wr = subprocess.Popen([ff,"-y","-v","error","-f","rawvideo","-pix_fmt","rgb24","-s",f"{W}x{H}","-r","24","-i","-","-c:v","libx264","-crf","16","-preset","slow","-bf","0","-g","240","-pix_fmt","yuv420p","-an",out],stdin=subprocess.PIPE)
for i in range(N):
    o = m*F[i].astype(np.float32)+(1-m)*plate
    wr.stdin.write(np.clip(o+0.5,0,255).astype(np.uint8).tobytes())
wr.stdin.close(); wr.wait(); cv2.imwrite(sys.argv[3], (m[...,0]*255).astype(np.uint8)); print("written")
