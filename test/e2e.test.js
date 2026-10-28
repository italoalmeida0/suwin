// test/e2e.test.js - Automated tests for suwin
import assert from 'node:assert';
import { SuwinServer } from '../src/server.js';
import { runCommand, getStatus, activateService, deactivateService } from '../src/client.js';
import * as state from '../src/state.js';

async function runTests() {
  console.log('--- Starting suwin End-to-End Tests ---');

  // Use test directory for isolation
  process.env.SUWIN_DIR = process.cwd() + '/.test_suwin';
  state.ensureDir();

  const server = new SuwinServer({ tray: false });
  const info = await server.start(0);
  console.log(`✓ Server started on port ${info.port} in ${info.dir}`);

  try {
    // 1. Initial status test
    const status1 = await getStatus();
    assert.strictEqual(status1.active, false, 'Service should start inactive');
    console.log('✓ Initial status checked: service is inactive as expected');

    // 2. Running command while inactive should fail
    let failed = false;
    try {
      await runCommand({ argv: ['echo', 'test'] });
    } catch (err) {
      failed = true;
    }
    assert.strictEqual(failed, true, 'Running command while inactive must fail');
    console.log('✓ Command while inactive was rejected as expected');

    // 3. Activate service (server-side authorization)
    server.activate(5 * 60 * 1000);
    const status2 = await getStatus();
    assert.strictEqual(status2.active, true, 'Service should now be active');
    console.log(`✓ Service activated: active=${status2.active}, secondsLeft=${status2.secondsLeft}`);

    // 4. Run standard command and capture output
    let stdoutData = '';
    let stderrData = '';

    const dummyStdout = {
      write: (chunk) => { stdoutData += chunk.toString(); }
    };
    const dummyStderr = {
      write: (chunk) => { stderrData += chunk.toString(); }
    };

    const res = await runCommand({
      argv: [process.execPath, '-e', 'console.log("HELLO SUWIN"); process.stderr.write("STDERR OK\\n");'],
      stdout: dummyStdout,
      stderr: dummyStderr
    });

    assert.strictEqual(res.code, 0, 'Exit code should be 0');
    assert.ok(stdoutData.includes('HELLO SUWIN'), `stdout should contain HELLO SUWIN, got: ${stdoutData}`);
    assert.ok(stderrData.includes('STDERR OK'), `stderr should contain STDERR OK, got: ${stderrData}`);
    console.log('✓ Pipe command executed successfully and streamed stdout/stderr');

    // 5. Test builtin command without explicit shell flag (e.g. echo 1)
    let builtinStdout = '';
    const resBuiltin = await runCommand({
      argv: ['echo', 'BUILTIN_ECHO_WORKS'],
      shell: false,
      stdout: {
        write: (chunk) => { builtinStdout += chunk.toString(); }
      }
    });
    assert.strictEqual(resBuiltin.code, 0, 'Builtin exit code should be 0');
    assert.ok(builtinStdout.includes('BUILTIN_ECHO_WORKS'), 'Builtin echo command output verified');
    console.log('✓ Builtin command without shell flag executed successfully');

    // 6. Test shell command
    let shellStdout = '';
    const resShell = await runCommand({
      argv: ['echo', 'SHELL_COMMAND_SUCCESS'],
      shell: true,
      stdout: {
        write: (chunk) => { shellStdout += chunk.toString(); }
      }
    });

    assert.strictEqual(resShell.code, 0, 'Shell exit code should be 0');
    assert.ok(shellStdout.includes('SHELL_COMMAND_SUCCESS'), 'Shell command output verified');
    console.log('✓ Shell command executed successfully');

    // 7. Test timeout
    const resTimeout = await runCommand({
      argv: [process.execPath, '-e', 'setTimeout(() => {}, 10000);'],
      timeoutMs: 500
    });
    assert.strictEqual(resTimeout.code, 124, `Timeout exit code should be 124, got ${resTimeout.code}`);
    assert.strictEqual(resTimeout.reason, 'timeout', `Reason should be timeout, got ${resTimeout.reason}`);
    console.log('✓ Command timeout handled cleanly with exit code 124');

    // 7. Test deactivation
    server.deactivate();
    const status3 = await getStatus();
    assert.strictEqual(status3.active, false, 'Service should be inactive after deactivation');
    console.log('✓ Service deactivation verified');

    console.log('\n🎉 ALL TESTS PASSED SUCCESSFULLY! 🎉');
  } finally {
    await server.stop();
    state.removeEndpoint(process.env.SUWIN_DIR);
    console.log('✓ Server stopped and endpoint cleaned up');
  }
}

runTests().catch((err) => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
