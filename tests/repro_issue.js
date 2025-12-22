const Autolevel = require('../autolevel');

// Mock Socket
class MockSocket {
    constructor() {
        this.events = {};
        this.sentGcode = [];
        this.finalGcode = "";
    }
    on(event, callback) {
        this.events[event] = callback;
    }
    emit(event, ...args) {
    }
    // Autolevel calls sckw.sendGcode, which wraps execution
    // But sckw is initialized in constructor.
}

// We need to mock SocketWrap or the socket passed to Autolevel.
// Autolevel wraps socket in 'new SocketWrap(socket, options.port)'
// Let's look at autolevel code again.
// line 34: this.sckw = new SocketWrap(socket, options.port)
// So we need to mock what SocketWrap expects or mock SocketWrap itself.
// Since we require('../autolevel'), we can't easily mock SocketWrap unless we use a proxy or assume SocketWrap just works with our mock socket.
// Let's verify SocketWrap.
const SocketWrap = require('../socketwrap');
// Assume SocketWrap delegates to socket.

const socket = new MockSocket();
// Mock emit for SocketWrap usages
socket.emit = function (evt, ...args) {
    // console.log('Socket emit:', evt, args);
    if (evt === 'write') {
        // args: [port, type, data]
        // Autolevel sends gcode via sckw.sendGcode -> socket.emit('write', port, 'gcode', code)
        // Check args
        if (args[1] === 'gcode') {
            // This is just a message saying "AL: ..." usually
            // But loadGcode calls socket.emit('write', port, 'gcode',  `...`) ? 
            // process.stdout.write("Captured G-code chunk: " + args[2].substring(0, 50) + "...\n");
        }
    }
};

// Autolevel uses sckw.loadGcode for the final result.
// Let's override the sckw instance method on the autolevel object after creation, or mock `emit` to catch 'gcode:load' equivalent?
// No, autolevel.applyCompensation calls `this.sckw.loadGcode`.
// We should see what `SocketWrap.loadGcode` does. It probably emits something.

const autolevel = new Autolevel(socket, { port: 'test-port' });

// Monkey-patch sckw to capture output easily
autolevel.sckw.loadGcode = function (name, code) {
    console.log(">>> FINAL GCODE LOADED <<<");
    console.log(code);
    autolevel.finalGcode = code;
}
autolevel.sckw.sendGcode = function (code) {
    // console.log("LOG:", code);
}

// 1. Setup Probe Points
autolevel.probedPoints = [
    { x: 0, y: 0, z: 0 },
    { x: 100, y: 0, z: 0 },
    { x: 0, y: 100, z: 0 },
    { x: 100, y: 100, z: 10 }
];

// 2. Load G-code
const gcode = `
G21
G90
G0 Z5
G0 X0 Y0
G1 X10 Y0 ; Move 1
G1 X10 Y0 F500 ; Zero move, only F change
G1 X10 Y0 ; Zero move, duplicate
G2 X20 Y0 I5 J0 ; Arc
G1 X30 Y0
`;

autolevel.gcode = gcode.trim();
autolevel.gcodeFileName = 'test.nc';

// 3. Apply Compensation
console.log("Running applyCompensation...");
autolevel.applyCompensation();

// 4. Analysis
if (autolevel.finalGcode) {
    if (!autolevel.finalGcode.includes('F500')) {
        console.error("FAIL: F500 command missing!");
    } else {
        console.log("PASS: F500 command present.");
    }

    if (autolevel.finalGcode.includes('G2 X20')) {
        console.log("INFO: G2 command preserved (Not linearized yet).");
    } else {
        console.log("INFO: G2 command NOT found (Linearized?)");
    }

    // Check if Move 1 is there
    if (!autolevel.finalGcode.includes('X10.000 Y0.000')) {
        // The formatter uses toFixed(3)
        console.error("FAIL: Move 1 seems missing or malformed");
    }

    // Write files for manual verification
    const fs = require('fs');
    fs.writeFileSync('test_input.gcode', gcode);
    fs.writeFileSync('test_output.gcode', autolevel.finalGcode);
    console.log("Written test_input.gcode and test_output.gcode for verification");

} else {
    console.error("FAIL: No G-code generated");
}
