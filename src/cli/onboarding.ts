import { AppError } from '../domain/errors.js';

import type { AuthMethod, AuthChoice, AuthSetup } from '../domain/auth.js';
export type SetupUI = { interactive: boolean; write(message: string): void; ask(question: string): Promise<string> };
const label = (method: AuthMethod) => ({ chatgpt: 'ChatGPT account', 'api-key': 'OpenAI API key', unknown: 'Codex login (method not recognized)' })[method];

export async function onboard(auth: AuthSetup, ui: SetupUI, options: { auth?: AuthChoice; testConnection?: boolean } = {}): Promise<boolean> {
  let status = await auth.status();
  ui.write(status.saved ? `Saved sign-in: ${label(status.method)}.` : 'Welcome to DevAgents. Choose how to connect Codex.');
  let choice = options.auth;
  if (!choice && ui.interactive) {
    ui.write('1. ChatGPT account — uses your plan’s Codex allowance; access and usage limits apply.');
    ui.write('2. OpenAI API key — uses separate API billing; key input is hidden.');
    if (status.saved) ui.write('3. Continue with saved login (default).');
    do {
      const answer = await ui.ask(status.saved ? 'Choose [1/2/3, Enter = 3]: ' : 'Choose [1/2]: ');
      choice = answer === '1' ? 'chatgpt' : answer === '2' ? 'api-key' : status.saved && (answer === '3' || answer === '') ? 'saved' : undefined;
      if (!choice) ui.write('Please enter one of the displayed numbers.');
    } while (!choice);
  }
  choice ??= 'saved';
  if (choice === 'saved' && !status.saved) throw new AppError('missing_auth', 'No saved login. Run ./devagents start in your terminal to sign in.');
  if (choice !== 'saved') {
    if (!ui.interactive) throw new AppError('terminal_required', 'Sign-in needs an interactive terminal. Run ./devagents start in your terminal.');
    if (choice === 'chatgpt') {
      ui.write('Enable device code sign-in at https://chatgpt.com/#settings/Security (managed workspaces may require your administrator).');
      ui.write('Then open the official link printed below, sign in with ChatGPT, and enter the one-time code.');
    }
    await auth.login(choice);
    status = await auth.status();
    if (!status.saved || status.method !== choice) throw new AppError('login_unverified', 'The requested sign-in method was not confirmed. Run ./devagents start and try signing in again.');
    ui.write(`${label(status.method)} saved securely. Future starts can reuse it.`);
  }
  if (!status.saved) throw new AppError('missing_auth', 'No saved login.');
  ui.write(`Sign-in available: ${label(status.method)}. Model access has not been checked this start.`);
  let test = options.testConnection ?? false;
  if (!test && ui.interactive) {
    ui.write('The optional test sends a small request to the default Codex model. It uses your selected plan’s allowance or API credits. No project files are sent.');
    for (;;) {
      const answer = (await ui.ask('Test connection now? [y/N]: ')).toLowerCase();
      if (['', 'n', 'no'].includes(answer)) break;
      if (['y', 'yes'].includes(answer)) { test = true; break; }
      ui.write('Enter y or n.');
    }
  }
  if (!test) { ui.write('Connection test skipped. Model access will be checked when you run a task.'); return true; }
  ui.write('Testing the default Codex model…');
  const result = await auth.test(status.method);
  ui.write(result.message);
  return result.ok;
}
