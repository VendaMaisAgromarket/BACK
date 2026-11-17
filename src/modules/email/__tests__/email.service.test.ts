import { Transporter } from 'nodemailer';
import { EmailService } from '../email.service';

const FROM = 'Venda+ Agromarket <contato@vendamaisagro.com.br>';

function fakeTransporter(sendMail: jest.Mock): Transporter {
  return { sendMail } as unknown as Transporter;
}

describe('EmailService', () => {
  it('envia com o remetente configurado e devolve os destinatários aceitos', async () => {
    const sendMail = jest.fn().mockResolvedValue({
      messageId: '<abc@gmail.com>',
      accepted: ['comprador@example.com'],
      rejected: [],
    });
    const service = new EmailService(fakeTransporter(sendMail), FROM);

    const result = await service.sendMail({
      to: 'comprador@example.com',
      subject: 'Pedido confirmado',
      html: '<p>Olá</p>',
    });

    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({ from: FROM, to: 'comprador@example.com', subject: 'Pedido confirmado' })
    );
    expect(result).toEqual({
      messageId: '<abc@gmail.com>',
      accepted: ['comprador@example.com'],
      rejected: [],
    });
  });

  it('normaliza destinatários retornados como objetos de endereço', async () => {
    const sendMail = jest.fn().mockResolvedValue({
      messageId: '<id>',
      accepted: [{ name: 'Fulano', address: 'fulano@example.com' }],
      rejected: [],
    });
    const service = new EmailService(fakeTransporter(sendMail), FROM);

    const result = await service.sendMail({ to: 'fulano@example.com', subject: 's', html: 'h' });

    expect(result.accepted).toEqual(['fulano@example.com']);
  });

  it('propaga o erro quando o envio falha', async () => {
    const error = Object.assign(new Error('invalid_grant'), { code: 'EAUTH' });
    const sendMail = jest.fn().mockRejectedValue(error);
    const service = new EmailService(fakeTransporter(sendMail), FROM);

    await expect(service.sendMail({ to: 'x@example.com', subject: 's', html: 'h' })).rejects.toBe(error);
  });

  it('falha com mensagem clara quando as variáveis de e-mail não estão definidas', async () => {
    const service = new EmailService();
    const saved = process.env.GOOGLE_REFRESH_TOKEN;
    delete process.env.GOOGLE_REFRESH_TOKEN;

    try {
      await expect(service.sendMail({ to: 'x@example.com', subject: 's', html: 'h' })).rejects.toThrow(
        /GOOGLE_REFRESH_TOKEN/
      );
    } finally {
      if (saved !== undefined) process.env.GOOGLE_REFRESH_TOKEN = saved;
    }
  });
});
