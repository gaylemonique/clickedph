import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import sharp from "sharp";

const THERMAL_PATTERN = /(?:JK[-\s]?5802|POS[-\s]?(?:58|80)|XP[-\s]?(?:58|80)|ZJ[-\s]?(?:58|80)|(?:58|80)\s?mm|thermal|receipt|xprinter|gprinter|rongta|munbyn|epson\s+tm|star\s+tsp)/i;
const VIRTUAL_PATTERN = /(?:Microsoft|OneNote|Fax|PDF|XPS|DeskJet|LaserJet|OfficeJet)/i;
const KNOWN_USB_DEVICES = [
  { vendorId: "0483", productId: "5743", name: "Printer POS-58 / JK-5802H" },
];
export const PRINT_TONE_PROFILE = "photo-safe-v4";
const PAPER_WHITE_CUTOFF = 232;

const usbPrintScript = path.resolve("print-agent/windows-usb-print.ps1");

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr.trim() || `${command} exited with code ${code}.`));
    });
  });
}

function scorePrinter(printer) {
  const identity = `${printer.Name ?? ""} ${printer.DriverName ?? ""}`;
  if (VIRTUAL_PATTERN.test(identity)) return -100;
  let score = 0;
  if (THERMAL_PATTERN.test(identity)) score += 80;
  if (/^USB\d+$/i.test(printer.PortName ?? "")) score += 20;
  if (printer.WorkOffline === true || Number(printer.PrinterStatus) === 7) score -= 30;
  return score;
}

export function selectThermalPrinter(printers, preferredName = process.env.THERMAL_PRINTER_NAME) {
  if (preferredName) {
    return printers.find((printer) => printer.Name?.toLowerCase() === preferredName.toLowerCase()) ?? null;
  }
  const ranked = printers.map((printer) => ({ printer, score: scorePrinter(printer) })).sort((a, b) => b.score - a.score);
  return ranked[0]?.score >= 60 ? ranked[0].printer : null;
}

export function selectUsbThermalPrinter(devices, preferredId = process.env.THERMAL_USB_ID) {
  if (preferredId) {
    const normalized = preferredId.replace(/[^a-f0-9]/gi, "").toUpperCase();
    return devices.find((device) => `${device.vendorId ?? ""}${device.productId ?? ""}`.toUpperCase() === normalized) ?? null;
  }
  const ranked = devices.map((device) => {
    let score = 0;
    if (device.known) score += 100;
    if (THERMAL_PATTERN.test(device.name ?? "")) score += 90;
    if (VIRTUAL_PATTERN.test(device.name ?? "")) score -= 100;
    return { device, score };
  }).sort((a, b) => b.score - a.score);
  return ranked[0]?.score >= 80 ? ranked[0].device : null;
}

export async function listWindowsPrinters() {
  if (process.platform !== "win32") return [];
  const script = "Get-CimInstance Win32_Printer | Select-Object Name,DriverName,PortName,PrinterStatus,WorkOffline,Default | ConvertTo-Json -Compress";
  const output = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]);
  if (!output) return [];
  const parsed = JSON.parse(output);
  return Array.isArray(parsed) ? parsed : [parsed];
}

export async function listUsbPrinterInterfaces() {
  if (process.platform !== "win32") return [];
  const metadataScript = "Get-CimInstance Win32_PnPEntity | Where-Object { $_.Present -and $_.Service -eq 'usbprint' } | Select-Object Name,DeviceID,Manufacturer,Status | ConvertTo-Json -Compress";
  const [output, metadataOutput] = await Promise.all([
    run("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      usbPrintScript,
      "-ListOnly",
    ]),
    run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", metadataScript]),
  ]);
  if (!output) return [];
  const parsedMetadata = metadataOutput ? JSON.parse(metadataOutput) : [];
  const metadata = Array.isArray(parsedMetadata) ? parsedMetadata : [parsedMetadata];
  return output.split(/\r?\n/).map((devicePath) => {
    const upperPath = devicePath.toUpperCase();
    const ids = upperPath.match(/VID_([0-9A-F]{4})&PID_([0-9A-F]{4})/);
    const vendorId = ids?.[1] ?? null;
    const productId = ids?.[2] ?? null;
    const known = KNOWN_USB_DEVICES.find((device) => device.vendorId === vendorId && device.productId === productId);
    const pnp = metadata.find((device) => (device.DeviceID ?? "").toUpperCase().includes(`VID_${vendorId}&PID_${productId}`));
    return {
      path: devicePath,
      name: known?.name ?? pnp?.Name ?? "USB printer",
      manufacturer: pnp?.Manufacturer ?? null,
      status: pnp?.Status ?? "Unknown",
      known: Boolean(known),
      connectionType: "USB printer class",
      usbId: vendorId && productId ? `${vendorId}:${productId}` : null,
      vendorId,
      productId,
    };
  });
}

export async function discoverPrinter() {
  const usbDevices = await listUsbPrinterInterfaces().catch(() => []);
  const usbDevice = selectUsbThermalPrinter(usbDevices);
  if (usbDevice) {
    return { detected: true, ready: true, mode: "usb-direct", name: usbDevice.name, device: usbDevice, queue: null, usbDevices };
  }
  const queues = await listWindowsPrinters().catch(() => []);
  const queue = selectThermalPrinter(queues);
  if (queue) {
    const offline = queue.WorkOffline === true || Number(queue.PrinterStatus) === 7;
    return { detected: true, ready: !offline, mode: "windows-queue", name: queue.Name, device: null, queue, usbDevices };
  }
  return { detected: false, ready: false, mode: null, name: null, device: null, queue: null, usbDevices };
}

export function buildEscPosRaster(grayscale, width, height) {
  if (grayscale.length !== width * height) throw new Error("Raster data dimensions do not match its pixel buffer.");
  const widthBytes = Math.ceil(width / 8);
  const raster = Buffer.alloc(8 + widthBytes * height);
  raster.set([0x1d, 0x76, 0x30, 0x00, widthBytes & 0xff, (widthBytes >> 8) & 0xff, height & 0xff, (height >> 8) & 0xff]);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (grayscale[y * width + x] < 145) {
        raster[8 + y * widthBytes + Math.floor(x / 8)] |= 0x80 >> (x % 8);
      }
    }
  }
  return raster;
}

export function autoToneGrayscale(grayscale) {
  const histogram = new Uint32Array(256);
  let usablePixels = 0;
  for (const value of grayscale) {
    if (value > 5 && value < 250) {
      histogram[value] += 1;
      usablePixels += 1;
    }
  }
  if (usablePixels === 0) return Buffer.from(grayscale);

  const midpoint = Math.ceil(usablePixels / 2);
  let running = 0;
  let median = 128;
  for (let value = 6; value < 250; value += 1) {
    running += histogram[value];
    if (running >= midpoint) {
      median = value;
      break;
    }
  }

  const targetMedian = 218;
  const rawGamma = Math.log(targetMedian / 255) / Math.log(Math.max(median, 8) / 255);
  const gamma = Math.min(0.28, Math.max(0.18, rawGamma));
  return Buffer.from(Uint8Array.from(grayscale, (value) => {
    if (value <= 4) return 0;
    if (value >= 250) return 255;
    return Math.round(255 * Math.pow(value / 255, gamma));
  }));
}

export function preservePaperWhite(grayscale) {
  return Buffer.from(Uint8Array.from(grayscale, (value) => value >= PAPER_WHITE_CUTOFF ? 255 : value));
}

export function ditherGrayscale(grayscale, width, height) {
  const working = Float32Array.from(grayscale);
  const output = Buffer.alloc(grayscale.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      const oldValue = Math.max(0, Math.min(255, working[index]));
      const newValue = oldValue < 150 ? 0 : 255;
      output[index] = newValue;
      const error = (oldValue - newValue) / 8;
      if (x + 1 < width) working[index + 1] += error;
      if (x + 2 < width) working[index + 2] += error;
      if (y + 1 < height) {
        if (x > 0) working[index + width - 1] += error;
        working[index + width] += error;
        if (x + 1 < width) working[index + width + 1] += error;
      }
      if (y + 2 < height) working[index + width * 2] += error;
    }
  }
  return output;
}

export async function pngToEscPos(pngBuffer) {
  const { data, info } = await sharp(pngBuffer)
    .flatten({ background: "#ffffff" })
    .resize({ width: 384, withoutEnlargement: false })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const corrected = preservePaperWhite(autoToneGrayscale(data));
  const dithered = ditherGrayscale(corrected, info.width, info.height);
  const raster = buildEscPosRaster(dithered, info.width, info.height);
  return Buffer.concat([
    Buffer.from([0x1b, 0x40]),
    Buffer.from([0x1b, 0x61, 0x01]),
    raster,
    Buffer.from([0x1b, 0x64, 0x05]),
  ]);
}

export async function writeDirectUsb(dataFile, device) {
  if (!device?.vendorId || !device?.productId) throw new Error("The selected USB printer has no usable VID/PID identity.");
  const match = `VID_${device.vendorId}&PID_${device.productId}`;
  return run("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    usbPrintScript,
    "-DataFile",
    path.resolve(dataFile),
    "-DeviceMatch",
    match,
  ]);
}
