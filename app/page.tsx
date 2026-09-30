"use client";

import {
  Aperture,
  ArrowLeft,
  ArrowRight,
  Camera,
  Check,
  CircleAlert,
  Frame,
  Images,
  LoaderCircle,
  Printer,
  RotateCcw,
  ScanFace,
  SlidersHorizontal,
  Sparkles,
  Type,
  WifiOff,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { resolvePrintAgentUrl } from "./print-agent-url";

type Screen = "welcome" | "layout" | "camera" | "preview" | "printing" | "complete";
type LayoutCount = 1 | 2 | 4 | 6;
type CameraPhase = "loading" | "ready" | "countdown" | "error";

type EditSettings = {
  brightness: number;
  contrast: number;
  spacing: number;
  cropY: number;
  border: boolean;
  caption: string;
};

const DEFAULT_SETTINGS: EditSettings = {
  brightness: 108,
  contrast: 108,
  spacing: 8,
  cropY: 50,
  border: true,
  caption: "CLICKED!",
};

const PRINT_AGENT_URL = resolvePrintAgentUrl(process.env.NEXT_PUBLIC_PRINT_AGENT_URL);
const PRINT_AGENT_HEALTH_URL = PRINT_AGENT_URL.replace(/\/print\/?$/, "/health");

const wait = (milliseconds: number) =>
  new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds));

const loadImage = (source: string) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = source;
  });

function formatDate() {
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  })
    .format(new Date())
    .toUpperCase();
}

function drawCover(
  context: CanvasRenderingContext2D,
  image: HTMLImageElement,
  x: number,
  y: number,
  width: number,
  height: number,
  cropY: number,
) {
  const sourceRatio = image.width / image.height;
  const targetRatio = width / height;
  let sourceWidth = image.width;
  let sourceHeight = image.height;
  let sourceX = 0;
  let sourceY = 0;

  if (sourceRatio > targetRatio) {
    sourceWidth = image.height * targetRatio;
    sourceX = (image.width - sourceWidth) / 2;
  } else {
    sourceHeight = image.width / targetRatio;
    sourceY = ((image.height - sourceHeight) * cropY) / 100;
  }

  context.drawImage(image, sourceX, sourceY, sourceWidth, sourceHeight, x, y, width, height);
}

async function buildReceipt(photos: string[], settings: EditSettings) {
  const width = 384;
  const margin = 20;
  const photoWidth = width - margin * 2;
  const photoHeight = photos.length === 1 ? 320 : 258;
  const gap = settings.spacing * 2;
  const footerHeight = 112;
  const height = margin + photos.length * photoHeight + Math.max(0, photos.length - 1) * gap + footerHeight;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("Canvas is not supported in this browser.");

  context.fillStyle = "#fff";
  context.fillRect(0, 0, width, height);

  for (let index = 0; index < photos.length; index += 1) {
    const image = await loadImage(photos[index]);
    const top = margin + index * (photoHeight + gap);
    context.save();
    context.filter = `grayscale(1) brightness(${settings.brightness}%) contrast(${settings.contrast}%)`;
    drawCover(context, image, margin, top, photoWidth, photoHeight, settings.cropY);
    context.restore();

    if (settings.border) {
      context.strokeStyle = "#000";
      context.lineWidth = 2;
      context.strokeRect(margin + 1, top + 1, photoWidth - 2, photoHeight - 2);
    }
  }

  const footerTop = height - footerHeight;
  context.fillStyle = "#000";
  context.textAlign = "center";
  context.font = "900 25px Arial";
  context.fillText(settings.caption.trim().slice(0, 28) || "CLICKED!", width / 2, footerTop + 42);
  context.font = "700 15px Arial";
  context.fillText(formatDate(), width / 2, footerTop + 69);
  context.fillRect(width / 2 - 24, footerTop + 86, 48, 4);

  return canvas.toDataURL("image/png");
}

function LayoutGlyph({ count }: { count: LayoutCount }) {
  return (
    <span className={`layout-glyph layout-glyph-${count}`} aria-hidden="true">
      {Array.from({ length: count }, (_, index) => (
        <span key={index} />
      ))}
    </span>
  );
}

function Progress({ screen }: { screen: Screen }) {
  const steps = ["Layout", "Camera", "Edit", "Print"];
  const active = screen === "welcome" ? -1 : screen === "layout" ? 0 : screen === "camera" ? 1 : screen === "preview" ? 2 : 3;
  return (
    <ol className="progress" aria-label="Clicked! progress">
      {steps.map((step, index) => (
        <li key={step} className={index === active ? "is-active" : index < active ? "is-done" : ""}>
          <span>{index < active ? <Check size={13} strokeWidth={3} /> : index + 1}</span>
          <b>{step}</b>
        </li>
      ))}
    </ol>
  );
}

function ThermalPreview({ photos, settings }: { photos: string[]; settings: EditSettings }) {
  return (
    <div className="receipt-shell" aria-label={`58 millimeter thermal receipt preview with ${photos.length} photos`}>
      <div className="receipt-notches" aria-hidden="true" />
      <div className="receipt-photos" style={{ gap: `${settings.spacing}px` }}>
        {photos.map((photo, index) => (
          // Captured webcam frames are local data URLs and must remain regular images.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            key={`${photo.slice(-24)}-${index}`}
            src={photo}
            alt={`Captured photo ${index + 1}`}
            style={{
              filter: `grayscale(1) brightness(${settings.brightness}%) contrast(${settings.contrast}%)`,
              objectPosition: `center ${settings.cropY}%`,
              border: settings.border ? "2px solid var(--black)" : "none",
            }}
          />
        ))}
      </div>
      <footer className="receipt-footer">
        <strong>{settings.caption.trim() || "CLICKED!"}</strong>
        <span>{formatDate()}</span>
        <i aria-hidden="true" />
      </footer>
    </div>
  );
}

export default function Home() {
  const [screen, setScreen] = useState<Screen>("welcome");
  const [layoutCount, setLayoutCount] = useState<LayoutCount>(4);
  const [photos, setPhotos] = useState<string[]>([]);
  const [settings, setSettings] = useState<EditSettings>(DEFAULT_SETTINGS);
  const [cameraPhase, setCameraPhase] = useState<CameraPhase>("loading");
  const [cameraError, setCameraError] = useState("");
  const [countdown, setCountdown] = useState<number | null>(null);
  const [shotNumber, setShotNumber] = useState(1);
  const [flash, setFlash] = useState(false);
  const [printError, setPrintError] = useState("");
  const [printerConnection, setPrinterConnection] = useState<{ status: "checking" | "ready" | "offline"; name?: string }>({ status: "checking" });
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const sequenceRunningRef = useRef(false);

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }, []);

  useEffect(() => () => stopCamera(), [stopCamera]);

  useEffect(() => {
    let active = true;
    const checkPrinter = async () => {
      try {
        const response = await fetch(PRINT_AGENT_HEALTH_URL, { cache: "no-store" });
        const health = await response.json();
        if (active) {
          setPrinterConnection(health?.printer?.ready
            ? { status: "ready", name: health.printer.name }
            : { status: "offline" });
        }
      } catch {
        if (active) setPrinterConnection({ status: "offline" });
      }
    };
    void checkPrinter();
    const poll = window.setInterval(() => void checkPrinter(), 3000);
    return () => {
      active = false;
      window.clearInterval(poll);
    };
  }, []);

  const openCamera = useCallback(async () => {
    stopCamera();
    setCameraPhase("loading");
    setCameraError("");
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error("This browser does not support camera access.");
      }
      let requestExpired = false;
      const cameraRequest = navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 960 } },
        audio: false,
      });
      cameraRequest.then((lateStream) => {
        if (requestExpired) lateStream.getTracks().forEach((track) => track.stop());
      }).catch(() => undefined);
      const stream = await Promise.race([
        cameraRequest,
        new Promise<never>((_resolve, reject) =>
          window.setTimeout(() => {
            requestExpired = true;
            reject(new Error("Camera permission timed out. Allow access in the browser, then try again."));
          }, 8000),
        ),
      ]);
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      setCameraPhase("ready");
    } catch (error) {
      const message = error instanceof DOMException && error.name === "NotAllowedError"
        ? "Camera access was blocked. Allow camera permission in the browser, then try again."
        : error instanceof Error
          ? error.message
          : "The camera could not be opened.";
      setCameraError(message);
      setCameraPhase("error");
    }
  }, [stopCamera]);

  const goToCamera = () => {
    setCameraPhase("loading");
    setScreen("camera");
    window.setTimeout(() => void openCamera(), 0);
  };

  const captureFrame = useCallback(() => {
    const video = videoRef.current;
    if (!video || video.videoWidth === 0) throw new Error("The camera is not ready yet.");
    const canvas = document.createElement("canvas");
    canvas.width = 900;
    canvas.height = 675;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas is not supported in this browser.");
    const sourceWidth = Math.min(video.videoWidth, video.videoHeight * (4 / 3));
    const sourceX = (video.videoWidth - sourceWidth) / 2;
    context.translate(canvas.width, 0);
    context.scale(-1, 1);
    context.drawImage(video, sourceX, 0, sourceWidth, video.videoHeight, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.92);
  }, []);

  const beginSequence = async () => {
    if (sequenceRunningRef.current || cameraPhase !== "ready") return;
    sequenceRunningRef.current = true;
    setCameraPhase("countdown");
    setPhotos([]);
    try {
      const captures: string[] = [];
      for (let photoIndex = 0; photoIndex < layoutCount; photoIndex += 1) {
        setShotNumber(photoIndex + 1);
        for (let tick = 3; tick >= 1; tick -= 1) {
          setCountdown(tick);
          await wait(900);
        }
        setCountdown(null);
        setFlash(true);
        captures.push(captureFrame());
        setPhotos([...captures]);
        await wait(520);
        setFlash(false);
        if (photoIndex < layoutCount - 1) await wait(430);
      }
      stopCamera();
      setScreen("preview");
    } catch (error) {
      setCameraError(error instanceof Error ? error.message : "The photo sequence stopped unexpectedly.");
      setCameraPhase("error");
    } finally {
      sequenceRunningRef.current = false;
      setCountdown(null);
      setFlash(false);
    }
  };

  const useDemoPhotos = async () => {
    const demoPhotos = Array.from({ length: layoutCount }, (_, index) => {
      const canvas = document.createElement("canvas");
      canvas.width = 900;
      canvas.height = 675;
      const context = canvas.getContext("2d");
      if (!context) return "";
      context.fillStyle = index % 2 === 0 ? "#d7b16e" : "#7891b5";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = "#111827";
      context.beginPath();
      context.arc(450, 245, 128, 0, Math.PI * 2);
      context.fill();
      context.fillRect(270, 370, 360, 230);
      context.fillStyle = "#fff";
      context.font = "900 42px Arial";
      context.textAlign = "center";
      context.fillText(`DEMO PHOTO ${index + 1}`, 450, 635);
      return canvas.toDataURL("image/png");
    });
    setPhotos(demoPhotos);
    setScreen("preview");
  };

  const startOver = () => {
    stopCamera();
    sequenceRunningRef.current = false;
    setPhotos([]);
    setSettings(DEFAULT_SETTINGS);
    setPrintError("");
    setScreen("welcome");
  };

  const printReceipt = async () => {
    setPrintError("");
    setScreen("printing");
    try {
      const image = await buildReceipt(photos, settings);
      const response = await fetch(PRINT_AGENT_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image, width: 384, copies: 1, requestedAt: new Date().toISOString() }),
      });
      const result = await response.json().catch(() => null);
      if (!response.ok) throw new Error(result?.error ?? `Print agent returned ${response.status}.`);
      await wait(1000);
      setScreen("complete");
    } catch (error) {
      setPrintError(error instanceof Error ? error.message : "The USB thermal printer did not respond.");
      setScreen("preview");
    }
  };

  return (
    <main className={`app app-${screen}`}>
      <header className="topbar">
        <button className="wordmark" onClick={startOver} aria-label="Return to start">
          <Aperture size={25} strokeWidth={2.6} />
          <span>CLICKED!</span>
        </button>
        {screen !== "welcome" && <Progress screen={screen} />}
        {screen !== "welcome" && screen !== "complete" ? (
          <button className="text-button" onClick={startOver}><RotateCcw size={17} /> Start over</button>
        ) : (
          <span className={`kiosk-chip is-${printerConnection.status}`} title={printerConnection.name}>
            <span /> {printerConnection.status === "ready" ? "Printer ready" : printerConnection.status === "checking" ? "Finding printer" : "Printer access needed"}
          </span>
        )}
      </header>

      {screen === "welcome" && (
        <section className="welcome-screen">
          <div className="welcome-copy">
            <span className="welcome-tag"><Sparkles size={16} /> Instant thermal keepsake</span>
            <h1>MAKE A<br /><em>MOMENT</em><br />YOU CAN HOLD.</h1>
            <p>Pick a strip, strike a pose, and print your photos on a tiny 58mm receipt.</p>
            <button className="primary-button hero-button" disabled={printerConnection.status !== "ready"} onClick={() => setScreen("layout")}>
              {printerConnection.status === "ready" ? "Start taking photos" : printerConnection.status === "checking" ? "Finding printer…" : "Waiting for printer access"} <ArrowRight size={22} />
            </button>
            {printerConnection.status === "offline" && <p className="printer-guidance" role="status">Allow “Local Network Access” in the browser, then make sure the Clicked! print agent and POS-58 printer are on. Detection retries automatically.</p>}
            <div className="welcome-details" aria-label="How it works">
              <span><b>01</b> Choose</span><span><b>02</b> Pose</span><span><b>03</b> Print</span>
            </div>
          </div>
          <div className="welcome-art" aria-hidden="true">
            <span className="art-caption">ONE STRIP. LOTS OF CHARACTER.</span>
            <div className="sample-receipt">
              {[0, 1, 2, 3].map((item) => (
                <div className={`sample-photo sample-photo-${item}`} key={item}>
                  <span /><i />
                </div>
              ))}
              <b>GOOD TIMES ONLY</b>
              <small>{formatDate()}</small>
            </div>
            <span className="receipt-label"><Printer size={17} /> 58 MM THERMAL PRINT</span>
          </div>
        </section>
      )}

      {screen === "layout" && (
        <section className="content-screen layout-screen">
          <div className="screen-heading">
            <span className="step-label">First, pick your strip</span>
            <h1>How many photos?</h1>
            <p>The camera takes every photo automatically. You just keep posing.</p>
          </div>
          <div className="layout-options">
            {([1, 2, 4, 6] as LayoutCount[]).map((count) => (
              <button
                key={count}
                className={layoutCount === count ? "layout-option is-selected" : "layout-option"}
                onClick={() => setLayoutCount(count)}
                aria-pressed={layoutCount === count}
              >
                <span className="layout-check">{layoutCount === count && <Check size={17} strokeWidth={3} />}</span>
                <LayoutGlyph count={count} />
                <strong>{count} {count === 1 ? "PHOTO" : "PHOTOS"}</strong>
                <small>{count === 1 ? "One big portrait" : count === 2 ? "A quick double" : count === 4 ? "The classic strip" : "Maximum moments"}</small>
              </button>
            ))}
          </div>
          <div className="screen-actions split-actions">
            <button className="secondary-button" onClick={() => setScreen("welcome")}><ArrowLeft size={19} /> Back</button>
            <button className="primary-button" onClick={goToCamera}>
              Open camera <Camera size={20} />
            </button>
          </div>
        </section>
      )}

      {screen === "camera" && (
        <section className="camera-screen">
          <div className="camera-copy">
            <span className="step-label">{layoutCount}-photo sequence</span>
            <h1>{cameraPhase === "countdown" ? "Keep posing!" : "Step into frame."}</h1>
            <p>{cameraPhase === "countdown" ? `Taking photo ${shotNumber} of ${layoutCount}. We’ll handle the rest.` : "Look at the lens. Your preview is mirrored, just like a real booth."}</p>
            <div className="shot-track" aria-label={`${photos.length} of ${layoutCount} photos captured`}>
              {Array.from({ length: layoutCount }, (_, index) => (
                <span key={index} className={index < photos.length ? "is-captured" : index === shotNumber - 1 && cameraPhase === "countdown" ? "is-current" : ""}>
                  {index < photos.length ? <Check size={15} /> : index + 1}
                </span>
              ))}
            </div>
          </div>
          <div className="viewfinder-wrap">
            <div className={`viewfinder ${flash ? "is-flashing" : ""}`}>
              <video ref={videoRef} muted playsInline aria-label="Live camera preview" />
              <span className="corner corner-tl" /><span className="corner corner-tr" />
              <span className="corner corner-bl" /><span className="corner corner-br" />
              {cameraPhase === "loading" && (
                <div className="camera-overlay"><LoaderCircle className="spinner" size={34} /><strong>Opening camera…</strong></div>
              )}
              {cameraPhase === "error" && (
                <div className="camera-overlay camera-error">
                  <WifiOff size={36} />
                  <strong>Camera unavailable</strong>
                  <p>{cameraError}</p>
                </div>
              )}
              {countdown !== null && <div className="countdown" role="status" aria-live="assertive">{countdown}</div>}
              {flash && <div className="flash" />}
              <span className="live-chip"><i /> LIVE</span>
            </div>
            <div className="camera-actions">
              {cameraPhase === "ready" && (
                <button className="shutter-button" onClick={beginSequence}>
                  <span><ScanFace size={25} /></span>
                  Begin {layoutCount}-photo sequence
                </button>
              )}
              {cameraPhase === "countdown" && <div className="hold-still"><Camera size={20} /> Next shot is automatic</div>}
              {cameraPhase === "error" && (
                <div className="error-actions">
                  <button className="secondary-button" onClick={openCamera}>Try camera again</button>
                  <button className="text-button light" onClick={useDemoPhotos}>Use demo photos</button>
                </div>
              )}
            </div>
          </div>
        </section>
      )}

      {screen === "preview" && (
        <section className="preview-screen">
          <div className="editor-panel">
            <div className="screen-heading compact">
              <span className="step-label">Make it yours</span>
              <h1>Your strip is ready.</h1>
              <p>Small tweaks only—the thermal look is part of the charm.</p>
            </div>

            {printError && <div className="alert" role="alert"><CircleAlert size={20} /><span><strong>Printer not ready</strong>{printError}</span></div>}

            <div className="editor-group">
              <h2><SlidersHorizontal size={19} /> Image</h2>
              <span className="auto-light-badge"><Sparkles size={15} /> Auto lighting on</span>
              <p className="auto-light-copy">Shadows and skin tones are balanced automatically for black-and-white thermal paper.</p>
              <details className="advanced-controls">
                <summary>Optional manual adjustments</summary>
                <div>
                  <label>Contrast <output>{settings.contrast}%</output>
                    <input type="range" min="80" max="180" value={settings.contrast} onChange={(event) => setSettings({ ...settings, contrast: Number(event.target.value) })} />
                  </label>
                  <label>Brightness <output>{settings.brightness}%</output>
                    <input type="range" min="75" max="145" value={settings.brightness} onChange={(event) => setSettings({ ...settings, brightness: Number(event.target.value) })} />
                  </label>
                  <label>Vertical crop <output>{settings.cropY}%</output>
                    <input type="range" min="0" max="100" value={settings.cropY} onChange={(event) => setSettings({ ...settings, cropY: Number(event.target.value) })} />
                  </label>
                </div>
              </details>
            </div>

            <div className="editor-row">
              <div className="editor-group small-group">
                <h2><Frame size={19} /> Strip</h2>
                <label>Spacing <output>{settings.spacing}px</output>
                  <input type="range" min="0" max="20" value={settings.spacing} onChange={(event) => setSettings({ ...settings, spacing: Number(event.target.value) })} />
                </label>
                <button className={settings.border ? "toggle is-on" : "toggle"} onClick={() => setSettings({ ...settings, border: !settings.border })} aria-pressed={settings.border}>
                  <span /> Photo border <b>{settings.border ? "ON" : "OFF"}</b>
                </button>
              </div>
              <div className="editor-group small-group">
                <h2><Type size={19} /> Footer</h2>
                <label className="text-field">Caption
                  <input maxLength={28} value={settings.caption} onChange={(event) => setSettings({ ...settings, caption: event.target.value })} />
                </label>
              </div>
            </div>

            <div className="screen-actions editor-actions">
              <button className="secondary-button" onClick={goToCamera}><RotateCcw size={18} /> Retake</button>
              <button className="primary-button" onClick={printReceipt}><Printer size={20} /> Print photo</button>
            </div>
          </div>
          <div className="receipt-stage">
            <div className="size-ruler"><span /> 58 mm actual paper width <span /></div>
            <div className="receipt-scroll"><ThermalPreview photos={photos} settings={settings} /></div>
            <div className="preview-note"><Images size={17} /> Preview matches the printed crop</div>
          </div>
        </section>
      )}

      {screen === "printing" && (
        <section className="status-screen" aria-live="polite">
          <div className="print-animation" aria-hidden="true">
            <Printer size={76} strokeWidth={1.5} />
            <div className="paper-out"><span /><span /></div>
          </div>
          <span className="step-label">Sending to JK-5802H</span>
          <h1>Printing your moment…</h1>
          <p>Listen for the printer. Please don’t pull the paper yet.</p>
          <div className="printing-bar"><span /></div>
        </section>
      )}

      {screen === "complete" && (
        <section className="status-screen complete-screen">
          <div className="success-mark"><Check size={54} strokeWidth={3} /></div>
          <span className="step-label">All done</span>
          <h1>Your photo is ready!</h1>
          <p>Take your print from the tray. Thanks for striking a pose.</p>
          <button className="primary-button hero-button" onClick={startOver}>Take another photo <Camera size={21} /></button>
        </section>
      )}
    </main>
  );
}
