import assert from "node:assert/strict";
import test from "node:test";
import { autoToneGrayscale, buildEscPosRaster, ditherGrayscale, selectThermalPrinter, selectUsbThermalPrinter } from "./printer.mjs";

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

test("cleans light backgrounds to paper white before dithering", () => {
  const wall = Buffer.from([206, 210, 216, 224, 230, 245, 255]);
  const corrected = autoToneGrayscale(wall);
  assert.ok(corrected.subarray(1).every((value) => value === 255), `expected light wall tones to become paper white, received ${[...corrected]}`);
});

test("keeps a dark face on a bright receipt from printing as a black mass", () => {
  const width = 32;
  const height = 32;
  const receipt = Buffer.alloc(width * height, 205);

  for (let index = 0; index < receipt.length; index += 7) receipt[index] = 255;
  for (let y = 6; y < 26; y += 1) {
    for (let x = 8; x < 24; x += 1) receipt[y * width + x] = 118;
  }
  for (let y = 10; y < 16; y += 1) {
    for (let x = 11; x < 21; x += 1) receipt[y * width + x] = 70;
  }

  const corrected = autoToneGrayscale(receipt);
  const dithered = ditherGrayscale(corrected, width, height);
  let blackFacePixels = 0;
  let facePixels = 0;
  let correctedFaceTotal = 0;
  for (let y = 6; y < 26; y += 1) {
    for (let x = 8; x < 24; x += 1) {
      const index = y * width + x;
      correctedFaceTotal += corrected[index];
      if (dithered[index] === 0) blackFacePixels += 1;
      facePixels += 1;
    }
  }

  const blackRatio = blackFacePixels / facePixels;
  const correctedAverage = correctedFaceTotal / facePixels;
  assert.ok(correctedAverage > 135, `expected lifted face tones, received average ${correctedAverage}`);
  assert.ok(blackRatio < 0.5, `expected printable face detail below 50% black, received ${blackRatio}`);
});

