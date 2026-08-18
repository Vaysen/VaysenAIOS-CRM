import { EventEmitter } from 'events';
import * as nodemailer from 'nodemailer';
import * as tls from 'tls';
import { createAbortableSmtpTransport } from './smtp-delivery';

jest.mock('nodemailer', () => ({ createTransport: jest.fn() }));
jest.mock('tls', () => ({ connect: jest.fn() }));

describe('abortable SMTP delivery', () => {
  it('passes native bounded timeouts and destroys the owned pinned socket on abort', () => {
    const socket: any = new EventEmitter();
    socket.destroyed = false;
    socket.destroy = jest.fn(() => { socket.destroyed = true; });
    (tls.connect as jest.Mock).mockReturnValue(socket);
    const close = jest.fn();
    (nodemailer.createTransport as jest.Mock).mockReturnValue({ close });
    const controller = new AbortController();

    const result = createAbortableSmtpTransport({
      host: '203.0.113.10',
      port: 465,
      secure: true,
      tls: {
        servername: 'smtp.example.test',
        minVersion: 'TLSv1.2',
        rejectUnauthorized: true,
      },
    }, { user: 'smtp-user', pass: 'redacted-test-password' }, controller.signal);
    const options = (nodemailer.createTransport as jest.Mock).mock.calls[0][0];
    expect(options).toMatchObject({
      host: '203.0.113.10',
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 40_000,
    });
    const callback = jest.fn();
    options.getSocket({}, callback);
    socket.emit('secureConnect');
    expect(callback).toHaveBeenCalledWith(null, {
      connection: socket,
      secured: true,
    });

    controller.abort();
    expect(socket.destroy).toHaveBeenCalledTimes(1);
    result.close();
    expect(close).toHaveBeenCalledTimes(1);
  });
});
