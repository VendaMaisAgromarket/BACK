import { PrismaClient, User } from "@prisma/client";
import bcrypt from "bcryptjs";
import { createHash, randomBytes } from "crypto";
import { isCPF, isCNPJ, formatToCPF, formatToCNPJ } from "brazilian-values";
import { AddressService } from "../address/address.service";
import { UploadS3Service } from "../upload-S3/uploadS3.service";
import { EmailService, emailService } from "../email/email.service";
import { logger } from "../../lib/logger";

/** Validade do link de redefinição de senha. */
export const PASSWORD_RESET_TTL_MINUTES = 30;
/** Intervalo mínimo entre dois e-mails de redefinição para o mesmo usuário (anti-spam). */
const PASSWORD_RESET_COOLDOWN_MS = 60_000;
/** Página do front que recebe o `?token=` e chama POST /user/change-password. */
const PASSWORD_RESET_FRONT_PATH = "/reset-password";

export const INVALID_RESET_TOKEN_MESSAGE = "Link de redefinição inválido ou expirado.";
export const WEAK_PASSWORD_MESSAGE =
  "A senha deve conter pelo menos 8 caracteres, incluindo uma letra maiúscula, uma letra minúscula, um número e um caractere especial.";
const PASSWORD_REGEX = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[\W_]).{8,}$/;

function hashResetToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export class UserService {
  private readonly prisma: PrismaClient;
  private readonly addressService: AddressService;
  private readonly uploadService: UploadS3Service;
  private readonly email: EmailService;

  constructor(prisma?: PrismaClient, email: EmailService = emailService) {
    this.prisma = prisma || new PrismaClient();
    this.addressService = new AddressService();
    this.uploadService = new UploadS3Service(this.prisma);
    this.email = email;
  }

  public async create(data: any): Promise<User> {
    const { name, phone_number, email, password, role, cpf, cnpj, ccir, securityQuestions } = data;

    if (!name || !phone_number || !email || !password || !role) {
      throw new Error("Campos obrigatórios faltando.");
    }

    const allowedRoles = ["buyer", "producer"];
    if (!allowedRoles.includes(role)) {
      throw new Error("Perfil inválido.");
    }

    if (!cpf && !cnpj) {
      throw new Error("CPF ou CNPJ é obrigatório.");
    }

    const passwordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[\W_]).{8,}$/;
    if (!passwordRegex.test(password)) {
      throw new Error(
        "A senha deve conter pelo menos 8 caracteres, incluindo uma letra maiúscula, uma letra minúscula, um número e um caractere especial."
      );
    }

    if (cpf) {
      if (!isCPF(cpf)) {
        throw new Error("CPF inválido.");
      }
      const formattedCpf = formatToCPF(cpf);
      const existingCpf = await this.prisma.user.findUnique({
        where: { cpf: formattedCpf }
      });
      if (existingCpf) {
        throw new Error("CPF já cadastrado.");
      }
    }

    if (cnpj) {
      if (!isCNPJ(cnpj)) {
        throw new Error("CNPJ inválido.");
      }
      const formattedCnpj = formatToCNPJ(cnpj);
      const existingCnpj = await this.prisma.user.findUnique({
        where: { cnpj: formattedCnpj }
      });
      if (existingCnpj) {
        throw new Error("CNPJ já cadastrado.");
      }
    }

    const existingEmail = await this.prisma.user.findUnique({
      where: { email }
    });
    if (existingEmail) {
      throw new Error("Email já cadastrado.");
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const securityQuestionsData = securityQuestions
      ? {
        create: {
          answer_1: await bcrypt.hash(securityQuestions.answer_1, 10),
          answer_2: await bcrypt.hash(securityQuestions.answer_2, 10),
          answer_3: await bcrypt.hash(securityQuestions.answer_3, 10),
        },
      }
      : undefined;

    try {
      const user = await this.prisma.user.create({
        data: {
          name,
          phone_number,
          email,
          password: hashedPassword,
          role,
          cpf: cpf ? formatToCPF(cpf) : null,
          cnpj: cnpj ? formatToCNPJ(cnpj) : null,
          img: null,
          ccir: ccir || null,
          securityQuestions: securityQuestionsData,
        },
        include: {
          securityQuestions: true,
        },
      });

      const { password: _, ...userWithoutPassword } = user;
      return userWithoutPassword as unknown as User;
    } catch (error) {
      console.error("Erro ao criar usuário:", error);
      throw error;
    }
  }

  public async createAdmin(data: any): Promise<Omit<User, 'password'>> {
    const { name, phone_number, email, password, cpf, cnpj } = data;

    if (!name || !phone_number || !email || !password) {
      throw new Error("Campos obrigatórios faltando.");
    }

    if (!cpf && !cnpj) {
      throw new Error("CPF ou CNPJ é obrigatório.");
    }

    const passwordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[\W_]).{8,}$/;
    if (!passwordRegex.test(password)) {
      throw new Error(
        "A senha deve conter pelo menos 8 caracteres, incluindo uma letra maiúscula, uma letra minúscula, um número e um caractere especial."
      );
    }

    let formattedCpf: string | null = null;
    if (cpf) {
      if (!isCPF(cpf)) {
        throw new Error("CPF inválido.");
      }
      formattedCpf = formatToCPF(cpf);
      const existingCpf = await this.prisma.user.findUnique({ where: { cpf: formattedCpf } });
      if (existingCpf) {
        throw new Error("CPF já cadastrado.");
      }
    }

    let formattedCnpj: string | null = null;
    if (cnpj) {
      if (!isCNPJ(cnpj)) {
        throw new Error("CNPJ inválido.");
      }
      formattedCnpj = formatToCNPJ(cnpj);
      const existingCnpj = await this.prisma.user.findUnique({ where: { cnpj: formattedCnpj } });
      if (existingCnpj) {
        throw new Error("CNPJ já cadastrado.");
      }
    }

    const existingEmail = await this.prisma.user.findUnique({ where: { email } });
    if (existingEmail) {
      throw new Error("Email já cadastrado.");
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const user = await this.prisma.user.create({
      data: {
        name,
        phone_number,
        email,
        password: hashedPassword,
        cpf: formattedCpf,
        cnpj: formattedCnpj,
        role: "admin",
      },
    });

    const { password: _, ...userWithoutPassword } = user;
    return userWithoutPassword;
  }

  public async getAll(): Promise<Omit<User, 'password' | 'tokenVersion'>[]> {
    return this.prisma.user.findMany({
      select: {
        id: true,
        name: true,
        phone_number: true,
        email: true,
        cnpj: true,
        cpf: true,
        ccir: true,
        role: true,
        img: true,
        valid: true,
        asaas_customer_id: true,
      },
    });
  }

  public async getById(id: string): Promise<any> {
    const user = await this.prisma.user.findUnique({
      where: { id },
    });

    if (!user) return null;

    const defaultAddress = await this.addressService.getDefaultAddress(id);

    return {
      id: user.id,
      name: user.name,
      email: user.email,
      phone_number: user.phone_number,
      role: user.role,
      cpf: user.cpf,
      cnpj: user.cnpj,
      img: user.img,
      address: defaultAddress,
    };
  }


  public async update(
    id: string,
    data: Partial<User>,
    file?: Express.Multer.File
  ): Promise<User> {
    const user = await this.prisma.user.findUnique({
      where: { id },
      select: { id: true, email: true, cpf: true, cnpj: true, img: true }
    });

    if (!user) {
      throw new Error("Usuário não encontrado.");
    }

    const updateData: any = { ...data };
    delete updateData.role;
    delete updateData.valid;
    delete updateData.tokenVersion;

    if (data.password) {
      const passwordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[\W_]).{8,}$/;
      if (!passwordRegex.test(data.password)) {
        throw new Error("A nova senha não atende aos critérios de segurança.");
      }
      updateData.password = await bcrypt.hash(data.password, 10);
      // Encerra todas as sessões abertas, inclusive a de quem fez a troca.
      updateData.tokenVersion = { increment: 1 };
    }

    if (data.cpf && data.cpf !== user.cpf) {
      if (!isCPF(data.cpf)) {
        throw new Error("CPF inválido.");
      }
      const formattedCpf = formatToCPF(data.cpf);
      const existingCpf = await this.prisma.user.findUnique({
        where: { cpf: formattedCpf }
      });
      if (existingCpf && existingCpf.id !== id) {
        throw new Error("CPF já cadastrado por outro usuário.");
      }
      updateData.cpf = formattedCpf;
    }

    if (data.cnpj && data.cnpj !== user.cnpj) {
      if (!isCNPJ(data.cnpj)) {
        throw new Error("CNPJ inválido.");
      }
      const formattedCnpj = formatToCNPJ(data.cnpj);
      const existingCnpj = await this.prisma.user.findUnique({
        where: { cnpj: formattedCnpj }
      });
      if (existingCnpj && existingCnpj.id !== id) {
        throw new Error("CNPJ já cadastrado por outro usuário.");
      }
      updateData.cnpj = formattedCnpj;
    }

    if (data.email && data.email !== user.email) {
      const existingEmail = await this.prisma.user.findUnique({
        where: { email: data.email }
      });
      if (existingEmail && existingEmail.id !== id) {
        throw new Error("Email já cadastrado por outro usuário.");
      }
    }

    if (file) {
      if (user.img) {
        try {
          const oldKey = this.extractKeyFromUrl(user.img);
          if (oldKey) {
            await this.uploadService.delete(oldKey);
          }
        } catch (error) {
          console.warn("Erro ao deletar imagem antiga:", error);
        }
      }

      const { publicUrl } = await this.uploadService.upload(file);
      updateData.img = publicUrl;
    }

    try {
      const updatedUser = await this.prisma.user.update({
        where: { id },
        data: updateData,
        include: {
          securityQuestions: true,
        },
      });

      const { password: _, ...userWithoutPassword } = updatedUser;
      return userWithoutPassword as unknown as User;
    } catch (error) {
      console.error("Erro ao atualizar usuário:", error);
      throw error;
    }
  }

  private extractKeyFromUrl(url: string): string | null {
    try {
      const urlObj = new URL(url);
      return decodeURIComponent(urlObj.pathname.substring(1));
    } catch (error) {
      console.warn("Erro ao extrair key da URL:", url, error);
      return null;
    }
  }

  public async updateProfileImage(
    userId: string,
    file: Express.Multer.File
  ): Promise<string> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { img: true },
    });

    if (!user) {
      throw new Error("Usuário não encontrado.");
    }

    if (user.img) {
      try {
        const oldKey = this.extractKeyFromUrl(user.img);
        if (oldKey) {
          await this.uploadService.delete(oldKey);
        }
      } catch (error) {
        console.warn("Erro ao deletar imagem antiga:", error);
      }
    }

    const { publicUrl } = await this.uploadService.upload(file);

    await this.prisma.user.update({
      where: { id: userId },
      data: { img: publicUrl },
    });

    return publicUrl;
  }

  public async delete(id: string): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) throw new Error("Usuário não encontrado.");

    await this.prisma.user.delete({ where: { id } });
  }

  // ─── Esqueci minha senha ─────────────────────────────────────────────────────

  /**
   * Gera um link de uso único e envia por e-mail. Nunca revela se o e-mail existe: quem chama
   * responde sempre a mesma mensagem, e o envio do e-mail roda em segundo plano para que o tempo
   * de resposta também não denuncie a existência da conta.
   */
  public async sendResetPassword(rawEmail: string, now: Date = new Date()): Promise<void> {
    const email = rawEmail.trim();
    if (!email) throw new Error("Campos obrigatórios faltando.");

    const frontendUrl = process.env.URL_FRONTEND;
    if (!frontendUrl) throw new Error("URL_FRONTEND não configurada.");

    const user = await this.prisma.user.findFirst({
      where: { email: { equals: email, mode: "insensitive" } },
      select: { id: true, name: true, email: true },
    });
    if (!user) return;

    const recent = await this.prisma.passwordResetToken.findFirst({
      where: { userId: user.id, createdAt: { gt: new Date(now.getTime() - PASSWORD_RESET_COOLDOWN_MS) } },
      select: { id: true },
    });
    if (recent) return;

    const token = randomBytes(32).toString("base64url");
    // Um novo pedido invalida os links anteriores ainda não usados.
    await this.prisma.$transaction([
      this.prisma.passwordResetToken.updateMany({
        where: { userId: user.id, usedAt: null },
        data: { usedAt: now },
      }),
      this.prisma.passwordResetToken.create({
        data: {
          userId: user.id,
          tokenHash: hashResetToken(token),
          expiresAt: new Date(now.getTime() + PASSWORD_RESET_TTL_MINUTES * 60_000),
        },
      }),
    ]);

    const link = `${frontendUrl.replace(/\/+$/, "")}${PASSWORD_RESET_FRONT_PATH}?token=${token}`;
    this.email
      .sendMail({
        to: user.email,
        subject: "Redefinição de senha — Venda+ Agromarket",
        text:
          `Olá, ${user.name}.\n\n` +
          `Recebemos um pedido para redefinir a senha da sua conta. Para criar uma nova senha, acesse o link abaixo ` +
          `(válido por ${PASSWORD_RESET_TTL_MINUTES} minutos e de uso único):\n\n${link}\n\n` +
          `Se você não fez esse pedido, ignore este e-mail: sua senha continua a mesma.`,
      })
      .catch((err: unknown) => {
        logger.error("[UserService] falha ao enviar e-mail de redefinição de senha:", err instanceof Error ? err.message : err);
      });
  }

  /** Troca a senha a partir do token do link. O token é consumido na mesma transação da troca. */
  public async changePassword(token: string, newPassword: string, now: Date = new Date()): Promise<void> {
    if (!token || !newPassword) throw new Error("Campos obrigatórios faltando.");
    if (!PASSWORD_REGEX.test(newPassword)) throw new Error(WEAK_PASSWORD_MESSAGE);

    const tokenHash = hashResetToken(token);
    const resetToken = await this.prisma.passwordResetToken.findUnique({
      where: { tokenHash },
      select: { id: true, userId: true, usedAt: true, expiresAt: true },
    });
    if (!resetToken || resetToken.usedAt || resetToken.expiresAt <= now) {
      throw new Error(INVALID_RESET_TOKEN_MESSAGE);
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);

    const user = await this.prisma.$transaction(async (tx) => {
      // Reserva condicional: duas requisições simultâneas com o mesmo link não trocam a senha duas vezes.
      const claimed = await tx.passwordResetToken.updateMany({
        where: { id: resetToken.id, usedAt: null, expiresAt: { gt: now } },
        data: { usedAt: now },
      });
      if (claimed.count === 0) throw new Error(INVALID_RESET_TOKEN_MESSAGE);

      await tx.passwordResetToken.updateMany({
        where: { userId: resetToken.userId, usedAt: null },
        data: { usedAt: now },
      });
      return tx.user.update({
        where: { id: resetToken.userId },
        // tokenVersion++ derruba os JWTs emitidos antes da troca (ver protectRoute).
        data: { password: hashedPassword, tokenVersion: { increment: 1 } },
        select: { name: true, email: true },
      });
    });

    this.email
      .sendMail({
        to: user.email,
        subject: "Sua senha foi alterada — Venda+ Agromarket",
        text:
          `Olá, ${user.name}.\n\n` +
          `A senha da sua conta foi alterada. Se não foi você, solicite uma nova redefinição de senha imediatamente ` +
          `e entre em contato com o suporte.`,
      })
      .catch((err: unknown) => {
        logger.error("[UserService] falha ao enviar e-mail de confirmação de troca de senha:", err instanceof Error ? err.message : err);
      });
  }
}