
const Autolevel = require('../src/extension/autolevel');

console.log("--- INTEGRATION TEST: Autolevel with Bilinear Mesh ---");

// Mock Socket
const mockSocket = {
    on: () => { },
    emit: () => { },
    removeListener: () => { }
};

// Create instance
const autolevel = new Autolevel(mockSocket, { port: 'COM1' });

// Mock sendGcode to capture output
let generatedGcode = "";
autolevel.sckw = {
    sendGcode: (code) => {
        // console.log("GCODE SENT:", code); // Verbose
    },
    loadGcode: (name, code) => {
        console.log(`loadGcode called for ${name}`);
        generatedGcode = code;
    }
};

// 1. Setup Probed Points (Zigzag 3x3 Grid)
// 0,0,0  10,0,0  20,0,0
// 0,10,0 10,10,5 20,10,0  (Middle bump at 10,10 -> Z=5)
// 0,20,0 10,20,0 20,20,0

autolevel.probedPoints = [
    { x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }, { x: 20, y: 0, z: 0 },   // Row 0
    { x: 20, y: 10, z: 0 }, { x: 10, y: 10, z: 5 }, { x: 0, y: 10, z: 0 },// Row 1 (Zigzag)
    { x: 0, y: 20, z: 0 }, { x: 10, y: 20, z: 0 }, { x: 20, y: 20, z: 0 } // Row 2
];

// 2. Load G-code
// We will move across the bump.
// G1 X0 Y10 Z0 -> Should be Z=0
// G1 X10 Y10 Z0 -> Should be Z=5 (0 + 5)
// G1 X5 Y10 Z0 -> Must interpolate. Z=2.5
// G1 X10 Y5 Z0 -> Must interpolate between (10,0,0) and (10,10,5) -> Z=2.5

const inputGcode = `
G21
G90
G1 X0 Y10 Z0
G1 X10 Y10 Z0
G1 X5 Y10 Z0
G1 X10 Y5 Z0
`;

autolevel.gcode = inputGcode;
autolevel.gcodeFileName = "test.nc";

// 3. Run Compensation
console.log("Running applyCompensation...");
autolevel.applyCompensation();

// 4. Verify Output
console.log("\n--- Generated G-Code Analysis ---");
const lines = generatedGcode.split('\n');

function checkLine(target, expectedZ) {
    // Find line containing target coords
    const found = lines.find(l => l.includes(target));
    if (found) {
        // Parse Z
        const zMatch = /Z([\.\-\d]+)/.exec(found);
        if (zMatch) {
            const z = parseFloat(zMatch[1]);
            const diff = Math.abs(z - expectedZ);
            if (diff < 0.01) {
                console.log(`PASS: ${target} -> Z=${z} (Expected ${expectedZ})`);
            } else {
                console.error(`FAIL: ${target} -> Z=${z} (Expected ${expectedZ})`);
            }
        } else {
            console.error(`FAIL: ${target} -> No Z found`);
        }
    } else {
        console.error(`FAIL: Could not find move for ${target}`);
        console.log("Dump:", lines);
    }
}

checkLine("X0.000 Y10.000", 0.0);
checkLine("X10.000 Y10.000", 5.0);
checkLine("X5.000 Y10.000", 2.5);
checkLine("X10.000 Y5.000", 2.5);

console.log("\nIntegration Test Complete");
