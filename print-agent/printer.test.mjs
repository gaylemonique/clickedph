import assert from "node:assert/strict";
import test from "node:test";
import { autoToneGrayscale, buildEscPosRaster, ditherGrayscale, preservePaperWhite, selectThermalPrinter, selectUsbThermalPrinter } from "./printer.mjs";

const hpPrinter = {
  Name: "HP DeskJet 2700 series",
  DriverName: "Microsoft IPP Class Driver",
  PortName: "USB001",
  PrinterStatus: 3,
  WorkOffline: false,
};

test("does not mistake an ordinary USB printer for the thermal printer", () => {
  assert.equal(selectThermalPrinter([hpPrinter]), null);
});

test("automatically selects a JK-5802H Windows queue", () => {
  const thermal = {
    Name: "JK-5802H",
    DriverName: "POS-58 Printer Driver",
    PortName: "USB002",
    PrinterStatus: 3,
    WorkOffline: false,
  };
  assert.deepEqual(selectThermalPrinter([hpPrinter, thermal]), thermal);
});

test("recognizes common generic 58mm thermal queue names", () => {
  const thermal = {
    Name: "POS-58",
    DriverName: "Thermal Receipt Printer",
    PortName: "USB004",
    PrinterStatus: 3,
    WorkOffline: false,
  };
  assert.deepEqual(selectThermalPrinter([thermal]), thermal);
});

test("honors an explicit printer override without requiring name heuristics", () => {
  assert.deepEqual(selectThermalPrinter([hpPrinter], "HP DeskJet 2700 series"), hpPrinter);
});

test("selects a thermal USB interface by its reported device name without a hard-coded VID/PID", () => {
  const thermal = { name: "POS-80 Receipt Printer", vendorId: "1234", productId: "5678", path: "thermal-path" };
  const hp = { name: "HP DeskJet 2700 series", vendorId: "03F0", productId: "1853", path: "hp-path" };
  assert.deepEqual(selectUsbThermalPrinter([hp, thermal]), thermal);
});

test("does not automatically send thermal data to an unrelated USB printer", () => {
  const hp = { name: "HP DeskJet 2700 series", vendorId: "03F0", productId: "1853", path: "hp-path" };
  assert.equal(selectUsbThermalPrinter([hp]), null);
});

test("allows an unknown thermal model to be selected once by USB identity", () => {
  const generic = { name: "USB printer", vendorId: "CAFE", productId: "BEEF", path: "generic-path" };
  assert.deepEqual(selectUsbThermalPrinter([generic], "CAFE:BEEF"), generic);
});

test("encodes a one-row monochrome image as ESC/POS raster data", () => {
  const raster = buildEscPosRaster(Buffer.from([0, 255, 0, 255, 0, 255, 0, 255]), 8, 1);
  assert.deepEqual([...raster.subarray(0, 8)], [0x1d, 0x76, 0x30, 0x00, 0x01, 0x00, 0x01, 0x00]);
  assert.equal(raster[8], 0b10101010);
});

test("automatically lifts an underexposed photo while preserving true black and white", () => {
  const darkPhoto = Buffer.from([0, 18, 28, 38, 48, 58, 68, 78, 255]);
  const corrected = autoToneGrayscale(darkPhoto);
  assert.equal(corrected[0], 0);
  assert.equal(corrected.at(-1), 255);
  assert.ok(corrected[4] > 95, `expected shadow detail to be lifted, received ${corrected[4]}`);
});

test("dithering turns a dark midtone into printable detail instead of a solid black block", () => {
  const midtone = Buffer.alloc(64, 72);
  const dithered = ditherGrayscale(midtone, 8, 8);
  assert.ok(dithered.includes(0));
  assert.ok(dithered.includes(255));
});

test("thermal tone mapping keeps face midtones from printing mostly black", () => {
  const width = 64;
  const height = 64;
  const grayscale = [];
  const faceMidtonePixels = [];

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const dx = (x - 32) / 32;
      const dy = (y - 32) / 32;
      const radius = Math.sqrt(dx * dx + dy * dy);
      let value = 235;
      let isFaceMidtone = false;

      if (radius < 0.78) {
        value = 132 + Math.round(45 * (1 - radius / 0.78));
        isFaceMidtone = true;
      }
      if (y < 24 && Math.abs(x - 32) < 22) {
        value = 45;
        isFaceMidtone = false;
      }
      if (y > 29 && y < 36 && x > 20 && x < 44) value = 105;

      grayscale.push(value);
      faceMidtonePixels.push(isFaceMidtone);
    }
  }

  const corrected = autoToneGrayscale(Buffer.from(grayscale));
  const dithered = ditherGrayscale(corrected, width, height);
  const faceInkRatio = dithered.reduce((blackPixels, value, index) => {
    return blackPixels + (faceMidtonePixels[index] && value === 0 ? 1 : 0);
  }, 0) / faceMidtonePixels.filter(Boolean).length;

  assert.ok(faceInkRatio < 0.3, `expected face midtones to stay printable, received ${faceInkRatio}`);
});

test("thermal tone mapping protects faces against a bright wall background", () => {
  const width = 64;
  const height = 76;
  const grayscale = [];
  const faceArea = [];

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const dx = (x - 32) / 24;
      const dy = (y - 34) / 30;
      const radius = Math.sqrt(dx * dx + dy * dy);
      let value = 232;
      const isFaceArea = radius < 0.82 && y > 15 && y < 62;

      if (isFaceArea) value = 92 + Math.round(44 * (1 - Math.min(radius, 0.82) / 0.82));
      if (y < 31 && Math.abs(x - 32) < 21) value = 38;
      if (y > 34 && y < 40 && x > 20 && x < 44) value = 76;

      grayscale.push(value);
      faceArea.push(isFaceArea);
    }
  }

  const corrected = autoToneGrayscale(Buffer.from(grayscale));
  const dithered = ditherGrayscale(corrected, width, height);
  const faceInkRatio = dithered.reduce((blackPixels, value, index) => {
    return blackPixels + (faceArea[index] && value === 0 ? 1 : 0);
  }, 0) / faceArea.filter(Boolean).length;

  assert.ok(faceInkRatio < 0.32, `expected bright-background face ink to stay controlled, received ${faceInkRatio}`);
});

test("paper-white cleanup prevents bright backgrounds from dithering into visible dots", () => {
  const width = 64;
  const height = 76;
  const grayscale = [];
  const background = [];
  const faceArea = [];

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const dx = (x - 32) / 24;
      const dy = (y - 34) / 30;
      const radius = Math.sqrt(dx * dx + dy * dy);
      const isFaceArea = radius < 0.82 && y > 15 && y < 62;
      const isHair = y < 31 && Math.abs(x - 32) < 21;
      let value = 233;

      if (isFaceArea) value = 102 + Math.round(42 * (1 - Math.min(radius, 0.82) / 0.82));
      if (isHair) value = 38;

      grayscale.push(value);
      background.push(!isFaceArea && !isHair);
      faceArea.push(isFaceArea);
    }
  }

  const dithered = ditherGrayscale(preservePaperWhite(autoToneGrayscale(Buffer.from(grayscale))), width, height);
  const backgroundInkRatio = dithered.reduce((blackPixels, value, index) => {
    return blackPixels + (background[index] && value === 0 ? 1 : 0);
  }, 0) / background.filter(Boolean).length;
  const faceInkRatio = dithered.reduce((blackPixels, value, index) => {
    return blackPixels + (faceArea[index] && value === 0 ? 1 : 0);
  }, 0) / faceArea.filter(Boolean).length;

  assert.ok(backgroundInkRatio < 0.004, `expected bright background to stay paper white, received ${backgroundInkRatio}`);
  assert.ok(faceInkRatio > 0.12, `expected face detail to remain printable, received ${faceInkRatio}`);
});
