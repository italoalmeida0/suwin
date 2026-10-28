// src/tray.js - Native Windows Notification Area (System Tray) via koffi FFI
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exec } from 'node:child_process';
import koffi from 'koffi';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Win32 constants
const WM_USER = 0x0400;
const WM_TRAY = WM_USER + 100;
const WM_RBUTTONUP = 0x0205;
const WM_LBUTTONUP = 0x0202;
const WM_CONTEXTMENU = 0x007B;

const NIM_ADD = 0x00000000;
const NIM_MODIFY = 0x00000001;
const NIM_DELETE = 0x00000002;

const NIF_MESSAGE = 0x00000001;
const NIF_ICON = 0x00000002;
const NIF_TIP = 0x00000004;

const MF_STRING = 0x00000000;
const MF_SEPARATOR = 0x00000800;
const MF_GRAYED = 0x00000001;
const MF_DISABLED = 0x00000002;
const TPM_RETURNCMD = 0x0100;
const TPM_RIGHTBUTTON = 0x0002;
const PM_REMOVE = 0x0001;

const DESKTOP_ALL = 0x01FF;
const LR_LOADFROMFILE = 0x0010;
const LR_DEFAULTSIZE = 0x0040;
const IMAGE_ICON = 1;

// Menu Command IDs
const ID_STATUS = 100;
const ID_ACTIVATE_15M = 101;
const ID_ACTIVATE_1H = 102;
const ID_ACTIVATE_3H = 103;
const ID_ACTIVATE_24H = 104;
const ID_DEACTIVATE = 105;
const ID_OPEN_LOG = 106;
const ID_OPEN_FOLDER = 107;
const ID_QUIT = 108;

function toChar16Array(str, len) {
  const arr = new Array(len).fill(0);
  for (let i = 0; i < str.length && i < len - 1; i++) {
    arr[i] = str.charCodeAt(i);
  }
  return arr;
}

export class TrayIcon {
  constructor(server) {
    this.server = server;
    this.hwnd = null;
    this.nid = null;
    this.hIconInactive = null;
    this.hIconActive = null;
    this.pumpInterval = null;
    this.refreshInterval = null;
    this.lastActiveState = null;
    this.initialized = false;
  }

  start() {
    if (process.platform !== 'win32') return;

    try {
      const user32 = koffi.load('user32.dll');
      const shell32 = koffi.load('shell32.dll');
      const kernel32 = koffi.load('kernel32.dll');

      this.user32 = user32;
      this.shell32 = shell32;
      this.kernel32 = kernel32;

      // Define Win32 Types
      const GUID = koffi.struct('GUID_TRAY', {
        Data1: 'uint32',
        Data2: 'uint16',
        Data3: 'uint16',
        Data4: koffi.array('uint8', 8)
      });

      const NOTIFYICONDATAW = koffi.struct('NOTIFYICONDATAW_TRAY', {
        cbSize: 'uint32',
        hWnd: 'void*',
        uID: 'uint32',
        uFlags: 'uint32',
        uCallbackMessage: 'uint32',
        hIcon: 'void*',
        szTip: koffi.array('char16_t', 128),
        dwState: 'uint32',
        dwStateMask: 'uint32',
        szInfo: koffi.array('char16_t', 256),
        uTimeoutOrVersion: 'uint32',
        szInfoTitle: koffi.array('char16_t', 64),
        dwInfoFlags: 'uint32',
        guidItem: GUID,
        hBalloonIcon: 'void*'
      });

      const POINT = koffi.struct('POINT_TRAY', { x: 'int32', y: 'int32' });
      const MSG = koffi.struct('MSG_TRAY', {
        hwnd: 'void*',
        message: 'uint32',
        wParam: 'uintptr_t',
        lParam: 'intptr_t',
        time: 'uint32',
        pt: POINT
      });

      const WNDCLASSEXW = koffi.struct('WNDCLASSEXW_TRAY', {
        cbSize: 'uint32',
        style: 'uint32',
        lpfnWndProc: 'void*',
        cbClsExtra: 'int32',
        cbWndExtra: 'int32',
        hInstance: 'void*',
        hIcon: 'void*',
        hCursor: 'void*',
        hbrBackground: 'void*',
        lpszMenuName: 'const char16_t*',
        lpszClassName: 'const char16_t*',
        hIconSm: 'void*'
      });

      // Declare functions
      this.OpenDesktopW = user32.func('void* __stdcall OpenDesktopW(const char16_t* lpszDesktop, uint32_t dwFlags, int fInherit, uint32_t dwDesiredAccess)');
      this.SetThreadDesktop = user32.func('int __stdcall SetThreadDesktop(void* hDesktop)');
      this.DefWindowProcW = user32.func('intptr_t __stdcall DefWindowProcW(void* hWnd, uint32_t Msg, uintptr_t wParam, intptr_t lParam)');
      this.RegisterClassExW = user32.func('uint16_t __stdcall RegisterClassExW(const WNDCLASSEXW_TRAY* lpwcx)');
      this.CreateWindowExW = user32.func('void* __stdcall CreateWindowExW(uint32_t dwExStyle, const char16_t* lpClassName, const char16_t* lpWindowName, uint32_t dwStyle, int X, int Y, int nWidth, int nHeight, void* hWndParent, void* hMenu, void* hInstance, void* lpParam)');
      this.DestroyWindow = user32.func('int __stdcall DestroyWindow(void* hWnd)');
      this.PeekMessageW = user32.func('int __stdcall PeekMessageW(_Out_ MSG_TRAY* lpMsg, void* hWnd, uint32_t wMsgFilterMin, uint32_t wMsgFilterMax, uint32_t wRemoveMsg)');
      this.TranslateMessage = user32.func('int __stdcall TranslateMessage(const MSG_TRAY* lpMsg)');
      this.DispatchMessageW = user32.func('intptr_t __stdcall DispatchMessageW(const MSG_TRAY* lpMsg)');
      this.PostMessageW = user32.func('int __stdcall PostMessageW(void* hWnd, uint32_t Msg, uintptr_t wParam, intptr_t lParam)');
      this.LoadImageW = user32.func('void* __stdcall LoadImageW(void* hInst, const char16_t* name, uint32_t type, int cx, int cy, uint32_t fuLoad)');
      this.Shell_NotifyIconW = shell32.func('int __stdcall Shell_NotifyIconW(uint32_t dwMessage, NOTIFYICONDATAW_TRAY* lpData)');
      this.GetModuleHandleW = kernel32.func('void* __stdcall GetModuleHandleW(const char16_t* lpModuleName)');
      this.CreatePopupMenu = user32.func('void* __stdcall CreatePopupMenu()');
      this.AppendMenuW = user32.func('int __stdcall AppendMenuW(void* hMenu, uint32_t uFlags, uintptr_t uIDNewItem, const char16_t* lpNewItem)');
      this.TrackPopupMenu = user32.func('int __stdcall TrackPopupMenu(void* hMenu, uint32_t uFlags, int x, int y, int nReserved, void* hWnd, void* prcRect)');
      this.DestroyMenu = user32.func('int __stdcall DestroyMenu(void* hMenu)');
      this.GetCursorPos = user32.func('int __stdcall GetCursorPos(_Out_ POINT_TRAY* lpPoint)');
      this.SetForegroundWindow = user32.func('int __stdcall SetForegroundWindow(void* hWnd)');

      // Connect to interactive default desktop
      try {
        const hDesk = this.OpenDesktopW('default', 0, 0, DESKTOP_ALL);
        if (hDesk) {
          this.SetThreadDesktop(hDesk);
        }
      } catch {}

      const hInstance = this.GetModuleHandleW(null);
      this.className = 'SuwinTrayClass_' + process.pid + '_' + Date.now();

      // Window procedure
      const WNDPROC = koffi.proto('intptr_t __stdcall WNDPROC_TRAY(void* hwnd, uint32_t uMsg, uintptr_t wParam, intptr_t lParam)');
      const wndProc = koffi.register((hwnd, uMsg, wParam, lParam) => {
        if (uMsg === WM_TRAY) {
          const event = Number(lParam);
          if (event === WM_RBUTTONUP || event === WM_LBUTTONUP || event === WM_CONTEXTMENU) {
            this.showContextMenu();
          }
          return 0;
        }
        return this.DefWindowProcW(hwnd, uMsg, wParam, lParam);
      }, koffi.pointer(WNDPROC));

      const wcx = {
        cbSize: koffi.sizeof(WNDCLASSEXW),
        style: 0,
        lpfnWndProc: wndProc,
        cbClsExtra: 0,
        cbWndExtra: 0,
        hInstance: hInstance,
        hIcon: null,
        hCursor: null,
        hbrBackground: null,
        lpszMenuName: null,
        lpszClassName: this.className,
        hIconSm: null
      };

      this.RegisterClassExW(wcx);

      this.hwnd = this.CreateWindowExW(0, this.className, 'SuwinTray', 0, 0, 0, 0, 0, null, null, hInstance, null);

      // Load icons
      const inactiveIco = path.resolve(__dirname, 'assets/inactive.ico');
      const activeIco = path.resolve(__dirname, 'assets/active.ico');

      this.hIconInactive = this.LoadImageW(null, inactiveIco, IMAGE_ICON, 0, 0, LR_LOADFROMFILE | LR_DEFAULTSIZE);
      this.hIconActive = this.LoadImageW(null, activeIco, IMAGE_ICON, 0, 0, LR_LOADFROMFILE | LR_DEFAULTSIZE);

      const isCurrentActive = this.server.isActive();
      const initialIcon = isCurrentActive ? this.hIconActive : this.hIconInactive;

      this.nid = {
        cbSize: koffi.sizeof(NOTIFYICONDATAW),
        hWnd: this.hwnd,
        uID: 1,
        uFlags: NIF_MESSAGE | NIF_ICON | NIF_TIP,
        uCallbackMessage: WM_TRAY,
        hIcon: initialIcon,
        szTip: toChar16Array(this.getTooltipText(), 128),
        dwState: 0,
        dwStateMask: 0,
        szInfo: new Array(256).fill(0),
        uTimeoutOrVersion: 0,
        szInfoTitle: new Array(64).fill(0),
        dwInfoFlags: 0,
        guidItem: { Data1: 0, Data2: 0, Data3: 0, Data4: new Array(8).fill(0) },
        hBalloonIcon: null
      };

      this.Shell_NotifyIconW(NIM_ADD, this.nid);
      this.lastActiveState = isCurrentActive;
      this.initialized = true;

      // Start message pump
      const msg = {
        hwnd: null,
        message: 0,
        wParam: 0n,
        lParam: 0n,
        time: 0,
        pt: { x: 0, y: 0 }
      };

      this.pumpInterval = setInterval(() => {
        while (this.PeekMessageW(msg, null, 0, 0, PM_REMOVE)) {
          this.TranslateMessage(msg);
          this.DispatchMessageW(msg);
        }
      }, 50);
      this.pumpInterval.unref();

      // Refresh tooltip and icon state every second
      this.refreshInterval = setInterval(() => {
        this.update();
      }, 1000);
      this.refreshInterval.unref();

    } catch (err) {
      if (this.server.logger?.warn) {
        this.server.logger.warn(`[suwin tray] Failed to initialize native tray: ${err.message}`);
      }
    }
  }

  getTooltipText() {
    const st = this.server.getStatus();
    if (!st.active) {
      return `suwin - Inactive (port ${st.port || this.server.port})`;
    }
    const mins = Math.floor(st.secondsLeft / 60);
    const secs = st.secondsLeft % 60;
    const durStr = mins > 0 ? `${mins}m ${secs}s left` : `${secs}s left`;
    return `suwin - ACTIVE (${durStr})`;
  }

  update() {
    if (!this.initialized || !this.nid) return;

    try {
      const active = this.server.isActive();
      const tip = this.getTooltipText();

      let needsModify = false;
      if (active !== this.lastActiveState) {
        this.nid.hIcon = active ? this.hIconActive : this.hIconInactive;
        this.lastActiveState = active;
        needsModify = true;
      }

      this.nid.szTip = toChar16Array(tip, 128);
      this.Shell_NotifyIconW(NIM_MODIFY, this.nid);
    } catch {}
  }

  showContextMenu() {
    if (!this.hwnd) return;

    const st = this.server.getStatus();
    const hMenu = this.CreatePopupMenu();

    const statusTitle = st.active
      ? `suwin: ACTIVE (${Math.floor(st.secondsLeft / 60)}m left, ${st.sessions} sessions)`
      : `suwin: INACTIVE (port ${this.server.port})`;

    this.AppendMenuW(hMenu, MF_STRING | MF_GRAYED | MF_DISABLED, ID_STATUS, statusTitle);
    this.AppendMenuW(hMenu, MF_SEPARATOR, 0, null);

    this.AppendMenuW(hMenu, MF_STRING, ID_ACTIVATE_15M, 'Activate for 15 minutes');
    this.AppendMenuW(hMenu, MF_STRING, ID_ACTIVATE_1H, 'Activate for 1 hour');
    this.AppendMenuW(hMenu, MF_STRING, ID_ACTIVATE_3H, 'Activate for 3 hours');
    this.AppendMenuW(hMenu, MF_STRING, ID_ACTIVATE_24H, 'Activate for 24 hours');
    this.AppendMenuW(hMenu, MF_SEPARATOR, 0, null);

    if (st.active) {
      this.AppendMenuW(hMenu, MF_STRING, ID_DEACTIVATE, 'Deactivate');
    } else {
      this.AppendMenuW(hMenu, MF_STRING | MF_GRAYED | MF_DISABLED, ID_DEACTIVATE, 'Deactivate');
    }

    this.AppendMenuW(hMenu, MF_SEPARATOR, 0, null);
    this.AppendMenuW(hMenu, MF_STRING, ID_OPEN_LOG, 'Open Log File');
    this.AppendMenuW(hMenu, MF_STRING, ID_OPEN_FOLDER, 'Open State Folder');
    this.AppendMenuW(hMenu, MF_SEPARATOR, 0, null);
    this.AppendMenuW(hMenu, MF_STRING, ID_QUIT, 'Quit');

    const pt = { x: 0, y: 0 };
    this.GetCursorPos(pt);
    this.SetForegroundWindow(this.hwnd);

    const cmd = this.TrackPopupMenu(hMenu, TPM_RETURNCMD | TPM_RIGHTBUTTON, pt.x, pt.y, 0, this.hwnd, null);
    this.DestroyMenu(hMenu);
    this.PostMessageW(this.hwnd, 0, 0, 0);

    if (cmd === ID_ACTIVATE_15M) {
      this.server.activate(15 * 60 * 1000);
      this.update();
    } else if (cmd === ID_ACTIVATE_1H) {
      this.server.activate(60 * 60 * 1000);
      this.update();
    } else if (cmd === ID_ACTIVATE_3H) {
      this.server.activate(3 * 60 * 60 * 1000);
      this.update();
    } else if (cmd === ID_ACTIVATE_24H) {
      this.server.activate(24 * 60 * 60 * 1000);
      this.update();
    } else if (cmd === ID_DEACTIVATE) {
      this.server.deactivate();
      this.update();
    } else if (cmd === ID_OPEN_LOG) {
      const logFile = path.join(this.server.stateDir, 'suwinsvc.log');
      exec(`notepad.exe "${logFile}"`);
    } else if (cmd === ID_OPEN_FOLDER) {
      exec(`explorer.exe "${this.server.stateDir}"`);
    } else if (cmd === ID_QUIT) {
      this.server.stop().then(() => {
        process.exit(0);
      });
    }
  }

  destroy() {
    if (this.pumpInterval) {
      clearInterval(this.pumpInterval);
      this.pumpInterval = null;
    }
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = null;
    }

    if (this.nid && this.Shell_NotifyIconW) {
      try {
        this.Shell_NotifyIconW(NIM_DELETE, this.nid);
      } catch {}
      this.nid = null;
    }

    if (this.hwnd && this.DestroyWindow) {
      try {
        this.DestroyWindow(this.hwnd);
      } catch {}
      this.hwnd = null;
    }

    this.initialized = false;
  }
}
