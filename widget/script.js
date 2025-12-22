(function () {
    const { $ } = window;
    const { Cookies } = window;

    // Widget State
    let settings = {
        feedrate: 50,
        height: 2,
        margin: 2.5,
        grid: 3
    };

    let probePoints = [];
    let minZ = Infinity;
    let maxZ = -Infinity;

    // Elements
    const elFeedrate = document.getElementById('feedrate');
    const elHeight = document.getElementById('height');
    const elMargin = document.getElementById('margin');
    const elGrid = document.getElementById('grid');
    const btnAutolevel = document.getElementById('btn-autolevel');
    const btnReapply = document.getElementById('btn-reapply');
    const canvas = document.getElementById('mesh-canvas');
    const ctx = canvas.getContext('2d');
    const statusText = document.getElementById('status-text');

    // Load Settings from Cookies or Defaults
    // (Optional implementation, skipping for simplicity)

    // Event Listeners
    btnAutolevel.addEventListener('click', () => {
        const f = elFeedrate.value;
        const h = elHeight.value;
        const m = elMargin.value;

        // Grid size is special, let's pass it if > 0
        const grid = elGrid.value;

        // Construct Command
        // #autolevel F50 H2 M2.5 GRID3
        // Note: autolevel.js looks for X and Y in command?
        // Wait, autolevel.js:
        // let xs = /X([\.\+\-\d]+)/gi.exec(cmd)
        // if (xs) xSize = parseFloat(xs[1])
        // If X/Y not provided, it attempts to use gcodeBounds or context.
        // The user request didn't mention X/Y fields, so we assume G-code bounds or context.

        let cmd = `#autolevel F${f} H${h} M${m}`;
        if (grid) {
            cmd += ` GRID${grid}`;
        }

        console.log('Sending Autolevel Command:', cmd);
        sendGcode(cmd);

        // Reset Visualizer
        resetVisualizer();
        statusText.innerText = "Autolevel started...";
    });

    btnReapply.addEventListener('click', () => {
        console.log('Sending Reapply Command');
        sendGcode('#autolevel_reapply');
        statusText.innerText = "Reapplying mesh...";
    });

    // CNCJS Communication
    // We expect 'cnc' object to be available in the global scope (standard widget)
    // or we might need to use standard socket events.

    // Helper to send GCode
    function sendGcode(cmd) {
        if (window.cnc && window.cnc.controller) {
            window.cnc.controller.command('gcode', cmd);
        } else {
            console.warn('CNC Controller not found, printing command:', cmd);
            // Fallback for testing/dev
        }
    }

    // Listener for incoming data to visualize
    // We need to hook into the socket or CNCJS events.
    // window.cnc.on('serialport:write', ...) usually isn't exposed directly to widgets like this
    // unless the widget is part of the system.
    // However, if we are a Custom Widget in CNCJS, we can access the socket.

    function onSerialData(data) {
        // We look for (AL: PROBED x y z)
        // Regex: \(AL: PROBED ([\.\+\-\d]+) ([\.\+\-\d]+) ([\.\+\-\d]+)\)

        // Handle incoming string (could be line or chunk)
        if (typeof data === 'string') {
            const lines = data.split('\n');
            lines.forEach(line => {
                const match = /\(AL: PROBED ([\.\+\-\d]+) ([\.\+\-\d]+) ([\.\+\-\d]+)\)/.exec(line);
                if (match) {
                    const x = parseFloat(match[1]);
                    const y = parseFloat(match[2]);
                    const z = parseFloat(match[3]);
                    addProbePoint(x, y, z);
                }

                // Also check for completion
                if (line.includes('(AL: finished)') || line.includes('(AL: dz_avg=')) {
                    statusText.innerText = "Autolevel complete.";
                    drawMesh();
                }
            });
        }
    }

    // Setup Socket Listener
    // Note: implementation depends on CNCJS version.
    // Try to attach to global socket if available.
    // This is "best effort" for a generic CNCJS widget.
    const socket = window.cnc ? window.cnc.socket : null;
    if (socket) {
        // Using 'serialport:write' because we (the extension) write the comment to the serial port channel?
        // Actually, autolevel.js calls this.sckw.sendGcode(...) which emits 'command'.
        // The CNCJS server *writes* this to the port.
        // The 'serialport:write' event is emitted when data is written to the port.
        // So we should see it there.
        socket.on('serialport:write', (data) => {
            // data might be raw buffer or string
            onSerialData(data.toString());
        });

        // Also listen to serialport:read just in case we change strategy or for debugging
        // socket.on('serialport:read', (data) => onSerialData(data.toString()));
    } else {
        console.warn('CNC Socket not found.');
    }


    // Visualizer Logic
    function resetVisualizer() {
        probePoints = [];
        minZ = Infinity;
        maxZ = -Infinity;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
    }

    function addProbePoint(x, y, z) {
        probePoints.push({ x, y, z });
        console.log('Point added:', x, y, z);

        if (z < minZ) minZ = z;
        if (z > maxZ) maxZ = z;

        drawMesh();
    }

    function drawMesh() {
        if (probePoints.length === 0) return;

        // Resize canvas to display
        canvas.width = canvas.parentElement.clientWidth;
        canvas.height = canvas.parentElement.clientHeight;

        ctx.clearRect(0, 0, canvas.width, canvas.height);

        // Find bounds for scaling
        let minX = Infinity, maxX = -Infinity;
        let minY = Infinity, maxY = -Infinity;

        probePoints.forEach(p => {
            if (p.x < minX) minX = p.x;
            if (p.x > maxX) maxX = p.x;
            if (p.y < minY) minY = p.y;
            if (p.y > maxY) maxY = p.y;
        });

        const padding = 20;
        const w = canvas.width - 2 * padding;
        const h = canvas.height - 2 * padding;

        const rangeX = maxX - minX || 0.1;
        const rangeY = maxY - minY || 0.1;
        const rangeZ = maxZ - minZ || 0.01; // Avoid divide by zero

        // Scale to fit
        const scaleX = w / rangeX;
        const scaleY = h / rangeY;
        // Keep aspect ratio? Maybe not necessary for simple visualizer

        // Draw Points (colored by Z)
        probePoints.forEach(p => {
            const px = padding + (p.x - minX) * scaleX;
            const py = canvas.height - (padding + (p.y - minY) * scaleY); // Flip Y for canvas

            // Color mapping: Blue (Low) -> Red (High)
            // Normalized Z (0 to 1)
            let normZ = (p.z - minZ) / rangeZ;
            if (isNaN(normZ)) normZ = 0.5;

            const r = Math.floor(normZ * 255);
            const b = 255 - r;

            ctx.fillStyle = `rgb(${r}, 0, ${b})`;
            ctx.beginPath();
            ctx.arc(px, py, 4, 0, 2 * Math.PI);
            ctx.fill();
        });

        statusText.innerText = `Points: ${probePoints.length} | Z Range: ${minZ.toFixed(3)} to ${maxZ.toFixed(3)}`;
    }

    window.addEventListener('load', () => {
        // Give CNCJS a moment to initialize the controller connection if needed
        setTimeout(() => {
            console.log('Requesting initial mesh...');
            sendGcode('#autolevel_get_mesh');
        }, 1000);
    });

})();
