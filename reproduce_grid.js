
const Autolevel = require('./autolevel');

// Mock socket
const mockSocket = {
    on: (event, callback) => { },
    emit: (event, ...args) => { },
    sendGcode: (gcode) => {
        console.log('GENERATED GCODE CHUNKS:');
        console.log(gcode);
    }
};

// Augment mockSocket specific for this extension use of sckw wrapper
mockSocket.emit.apply = (context, args) => { };


const options = {
    port: 'COM1',
    outDir: null
};

// Mock the sendGcode which is normally on the specific socketwrapper
// But autolevel class wraps it. We can just mock start to see what it generates.
// Actually, I need to see the output. AutoLevel uses `this.sckw.sendGcode`.
// We can mock `SocketWrap` or just rely on the logging since `sendGcode` is called on `this.sckw`.

// Let's mock the socket passed to Autolevel, but Autolevel wraps it in SocketWrap.
// Checking SocketWrap... it's a simple wrapper.
// I will just modify the Autolevel instance's sckw property after creation to intercept sendGcode.

const autolevel = new Autolevel(mockSocket, options);

// Mock the sckw directly
autolevel.sckw = {
    sendGcode: (code) => {
        console.log('--- GENERATED GCODE START ---');
        console.log(code);
        console.log('--- GENERATED GCODE END ---');
    }
};

// Test Case 1: Grid = 3, Size 10x10, Margin 0
// X: 0 - 10, Grid 3 => 0, 5, 10
// Y: 0 - 10, Grid 3 => 0, 5, 10
// Total points: 9

console.log("\nTEST 1: GRID=3 on 10x10 area");
autolevel.start('#autolevel GRID3 X10 Y10 M0 P1', { xmin: 0, xmax: 10, ymin: 0, ymax: 10 });

// Test Case 2: Grid overrides Distance
// Distance 2 would mean 5 steps (0, 2, 4, 6, 8, 10)
// Grid 2 means 2 steps (0, 10)
console.log("\nTEST 2: GRID=2 overrides D2 on 10x10 area");
autolevel.start('#autolevel GRID2 D2 X10 Y10 M0 P1', { xmin: 0, xmax: 10, ymin: 0, ymax: 10 });
