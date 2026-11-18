// Staff PINs the admin can see again:
//  - a default PIN (set once by the admin) that every new employee gets automatically
//  - every staff PIN is also kept locked (AES-GCM, key from the server pepper) so the admin can show it
//  - staff can change their own PIN in the staff app
import { bad, HttpError } from './util.js';
import { hashPin, checkPin, validPin } from './crypto.js';

const enc = new TextEncoder();
const dec = new TextDecoder();
const b64 = (u8) => btoa(String.fromCharCode(...u8));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export function installPins(Store) {
  const P = Store.prototype;

  P.pinsRoutes = function pinsRoutes(add, A) {
    add('GET', '/api/admin/default-pin', this.getDefaultPin, A('employees.edit'));
    add('PUT', '/api/admin/default-pin', this.putDefaultPin, A('employees.edit'));
    add('GET', '/api/admin/employees/:id/pin', this.viewEmpPin, A('employees.edit'));
    add('POST', '/api/emp/me/pin', this.empChangePin, { auth: 'emp' });
  };

  P.pinKey = async function pinKey() {
    if (!this._pinKey) {
      const raw = await crypto.subtle.digest('SHA-256', enc.encode(`${this.pepper}|pin-view`));
      this._pinKey = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
    }
    return this._pinKey;
  };
  P.sealPin = async function sealPin(pin) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await this.pinKey(), enc.encode(pin)));
    return `v1$${b64(iv)}$${b64(ct)}`;
  };
  P.openPin = async function openPin(s) {
    try {
      const [v, iv, ct] = String(s || '').split('$');
      if (v !== 'v1') return null;
      return dec.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, await this.pinKey(), unb64(ct)));
    } catch { return null; }
  };
  // call after every change of an employee PIN
  P.rememberPin = async function rememberPin(empId, pin) {
    this.db.kvSet(`pinv:${empId}`, await this.sealPin(String(pin)));
  };
  P.forgetPin = function forgetPin(empId) {
    this.db.run('DELETE FROM kv WHERE k = ?', `pinv:${empId}`);
  };

  P.defaultPin = async function defaultPin() {
    const s = this.db.kvGet('defaultPin', null);
    return s ? this.openPin(s) : null;
  };
  P.getDefaultPin = async function getDefaultPin() {
    return { pin: await this.defaultPin() };
  };
  P.putDefaultPin = async function putDefaultPin({ actor, body }) {
    const pin = String(body.pin || '');
    if (!pin) {
      this.db.run("DELETE FROM kv WHERE k = 'defaultPin'");
      this.audit(actor, 'settings.default_pin', null, { on: false });
      return { ok: true, pin: null };
    }
    if (!validPin(pin)) throw bad('BAD_PIN', 'PIN must be 4 to 6 digits');
    this.db.kvSet('defaultPin', await this.sealPin(pin));
    this.audit(actor, 'settings.default_pin', null, { on: true });
    return { ok: true, pin };
  };

  P.viewEmpPin = async function viewEmpPin({ actor, params }) {
    const e = this.empRow(params.id);
    const pin = await this.openPin(this.db.kvGet(`pinv:${e.id}`, null));
    const row = this.db.get('SELECT pin FROM employees WHERE id = ?', e.id);
    // a PIN set before this version can't be shown until it is set again
    const ok = pin && row?.pin && (await checkPin(pin, row.pin, this.pepper));
    this.audit(actor, 'employee.pin_viewed', e.id, { name: e.name });
    return { pin: ok ? pin : null, hasPin: !!row?.pin };
  };

  P.empChangePin = async function empChangePin({ actor, body, ip }) {
    const emp = this.empRow(actor.id);
    const keys = [`e:${emp.code.toLowerCase()}`, `ip:${ip}`];
    this.lockCheck(keys);
    const row = this.db.get('SELECT pin FROM employees WHERE id = ?', emp.id);
    if (!(await checkPin(String(body.oldPin || ''), row.pin, this.pepper))) {
      this.lockFail(keys);
      throw new HttpError(401, 'WRONG_PIN', 'Old PIN is wrong');
    }
    this.lockClear(keys[0]);
    const pin = String(body.newPin || '');
    if (!validPin(pin)) throw bad('BAD_PIN', 'PIN must be 4 to 6 digits');
    this.db.run('UPDATE employees SET pin = ?, updated = ? WHERE id = ?', await hashPin(pin, this.pepper), this.now(), emp.id);
    await this.rememberPin(emp.id, pin);
    this.audit({ id: emp.id, name: emp.name }, 'employee.pin_changed', emp.id, { name: emp.name });
    return { ok: true };
  };
}
