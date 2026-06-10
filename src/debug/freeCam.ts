import * as THREE from 'three';
import type { Input } from '../core/input';

const _mouse = { x: 0, y: 0 };
const _forward = new THREE.Vector3();
const _right = new THREE.Vector3();
const _move = new THREE.Vector3();
const _euler = new THREE.Euler(0, 0, 0, 'YXZ');

/**
 * Debug fly camera: WASD + mouse-look, Q/E down/up, Shift = fast.
 * Click the canvas to grab the pointer.
 */
export class FreeCam {
  enabled = true;
  speed = 8;
  fastMultiplier = 5;
  lookSensitivity = 0.0022;

  private yaw = 0;
  private pitch = 0;

  constructor(
    private camera: THREE.PerspectiveCamera,
    private input: Input,
  ) {
    // Adopt the camera's current orientation so enabling doesn't snap the view.
    const e = new THREE.Euler().setFromQuaternion(camera.quaternion, 'YXZ');
    this.yaw = e.y;
    this.pitch = e.x;
  }

  update(dt: number): void {
    if (!this.enabled) return;

    this.input.consumeMouseDelta(_mouse);
    this.yaw -= _mouse.x * this.lookSensitivity;
    this.pitch -= _mouse.y * this.lookSensitivity;
    this.pitch = Math.max(-1.55, Math.min(1.55, this.pitch));
    _euler.set(this.pitch, this.yaw, 0, 'YXZ');
    this.camera.quaternion.setFromEuler(_euler);

    _forward.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    _right.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    _move.set(0, 0, 0);
    if (this.input.pressed('KeyW')) _move.add(_forward);
    if (this.input.pressed('KeyS')) _move.sub(_forward);
    if (this.input.pressed('KeyD')) _move.add(_right);
    if (this.input.pressed('KeyA')) _move.sub(_right);
    if (this.input.pressed('KeyE')) _move.y += 1;
    if (this.input.pressed('KeyQ')) _move.y -= 1;

    if (_move.lengthSq() > 0) {
      _move.normalize();
      const speed = this.speed * (this.input.pressed('ShiftLeft') ? this.fastMultiplier : 1);
      this.camera.position.addScaledVector(_move, speed * dt);
    }
  }
}
