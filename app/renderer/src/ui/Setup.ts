import type { SetupState } from '../../../shared/types';
import { vow } from '../vow';

const POLL_MS = 1000;

export interface SetupPrefs {
  autoEnter(): boolean;
  setAutoEnter(on: boolean): void;
}

/**
 * Setup / permissions card. The app starts as a normal window showing it (when
 * the glasses are connected or a permission is missing); "Enter glasses view"
 * goes fullscreen on the glasses. Reopened with P, and by ⌃⌥Q from the glasses.
 */
export class Setup {
  private readonly el = document.getElementById('setup')!;
  private timer: number | null = null;
  private state: SetupState | null = null;
  /** Hide by itself once the window is fullscreen on the glasses (auto-enter at launch). */
  private autoClose = false;

  constructor(private readonly prefs: SetupPrefs) {
    this.el.addEventListener('click', (e) => {
      const action = (e.target as HTMLElement).closest('[data-action]')?.getAttribute('data-action');
      if (action) this.act(action);
    });
    this.el.addEventListener('change', (e) => {
      const t = e.target as HTMLInputElement;
      if (t.dataset.pref === 'autoEnter') this.prefs.setAutoEnter(t.checked);
    });
    vow.onShowSetup(() => {
      this.autoClose = false;
      void this.show();
    });
  }

  get open(): boolean {
    return !this.el.hidden;
  }

  /** Show if anything is missing; returns whether it was shown. */
  async showIfNeeded(): Promise<boolean> {
    const s = await vow.getSetup();
    const needed = s.screen !== 'granted' || (s.glassesConnected && (!s.accessibility || !s.immersive));
    if (needed) {
      this.autoClose = this.prefs.autoEnter();
      await this.show();
    }
    return needed;
  }

  async show(): Promise<void> {
    this.el.hidden = false;
    document.body.classList.add('setup-open');
    await this.refresh();
    if (this.timer === null) this.timer = window.setInterval(() => void this.refresh(), POLL_MS);
  }

  hide(): void {
    this.el.hidden = true;
    document.body.classList.remove('setup-open');
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  private act(action: string): void {
    switch (action) {
      case 'grant-screen':
        vow.requestScreenRecording();
        break;
      case 'grant-ax':
        vow.requestAccessibility();
        break;
      case 'relaunch':
        vow.relaunch();
        break;
      case 'enter':
        this.hide();
        if (this.state?.glassesConnected) vow.enterImmersive();
        break;
      case 'close':
        this.hide();
        break;
    }
  }

  private async refresh(): Promise<void> {
    const s = await vow.getSetup();
    if (this.autoClose && s.immersive) {
      this.hide();
      return;
    }
    const key = JSON.stringify(s);
    if (this.state && JSON.stringify(this.state) === key) return;
    this.state = s;

    const screenOk = s.screen === 'granted';
    const row = (ok: boolean, title: string, zh: string, why: string, button: string | null, pending = false) => `
      <div class="setup-row">
        <span class="setup-dot ${ok ? 'ok' : pending ? 'wait' : 'bad'}"></span>
        <div class="setup-text"><b>${title}</b> <span class="zh">${zh}</span><small>${why}</small></div>
        ${button ? `<button class="setup-btn" data-action="${button}">${ok ? 'Settings' : 'Grant…'}</button>` : ''}
      </div>`;

    this.el.innerHTML = `
      <div class="setup-card">
        <h1>Viture Open Walker</h1>
        <p class="setup-sub">Before entering the glasses view · 進入眼鏡畫面之前</p>
        ${row(
          screenOk,
          'Screen Recording',
          '螢幕錄製',
          screenOk ? 'Granted — your displays will show in 3D.' : 'Needed to show your displays inside the 3D space. After granting, press Restart.',
          'grant-screen',
        )}
        ${row(
          s.accessibility,
          'Accessibility',
          '輔助使用',
          s.accessibility ? 'Granted — windows are kept off the glasses.' : 'Lets the app move windows that open on the glasses onto a virtual display.',
          'grant-ax',
        )}
        ${row(
          s.glassesConnected,
          'VITURE glasses',
          '眼鏡',
          s.glassesConnected ? 'Connected.' : 'Not connected — you can still use the app with the mouse.',
          null,
          true,
        )}
        <p class="setup-note">
          macOS applies a new permission only after the app restarts. If System Settings already shows it on but this
          page doesn't, press Restart · 權限要重開 App 才會生效。
        </p>
        <label class="setup-check">
          <input type="checkbox" data-pref="autoEnter" ${this.prefs.autoEnter() ? 'checked' : ''} />
          Enter the glasses view automatically next time (skip this card) · 下次自動進入
        </label>
        <div class="setup-actions">
          <button class="setup-btn" data-action="relaunch">Restart app · 重新開啟</button>
          <button class="setup-btn primary" data-action="enter">
            ${s.glassesConnected ? (screenOk ? 'Enter glasses view · 進入' : 'Enter anyway (displays stay blank)') : 'Continue · 繼續'}
          </button>
        </div>
        <p class="setup-hint">In the glasses, <kbd>⌃⌥Q</kbd> always brings you back here · 在眼鏡裡隨時按 ⌃⌥Q 回到這裡</p>
      </div>`;
  }
}
