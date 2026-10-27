import sys, subprocess, numpy as np, cv2
from audio_analysis import ffmpeg_exe
ff=ffmpeg_exe(); w,h=960,540
for name,src in [("v1 drift","C:/Users/synex/OneDrive/Desktop/HOODSFIELD AI/final/Loops/Enchanted_Paradise_loop_4s_1080p_v1_drift.mp4"),("v2",sys.argv[1]),("v3",sys.argv[2])]:
    a=np.frombuffer(subprocess.run([ff,"-v","error","-i",src,"-vf",f"scale={w}:{h}:flags=area","-pix_fmt","gray","-f","rawvideo","-"],capture_output=True).stdout,np.uint8).reshape(-1,h,w)
    g=[cv2.GaussianBlur(x.astype(np.float32),(0,0),1.2) for x in a]; plate=np.median(g,0).astype(np.float32)
    mask=(np.abs(np.array(g)-plate).mean(0)<np.percentile(np.abs(np.array(g)-plate).mean(0),60)).astype(np.uint8)
    t=[]
    for x in g:
        M=np.eye(2,3,dtype=np.float32)
        try: _,M=cv2.findTransformECC(plate,x,M,cv2.MOTION_TRANSLATION,(3,200,1e-7),mask,5)
        except cv2.error: pass
        t.append(M[:,2].copy())
    t=np.array(t)*2   # to 1080p px
    d=np.diff(t,axis=0)
    print(name,"range x %.2f y %.2f | frame-to-frame jitter rms %.3f px | max %.2f"%(np.ptp(t[:,0]),np.ptp(t[:,1]),np.sqrt((d**2).sum(1).mean()),np.abs(d).max()))
