import { PrismaClient, User } from '@prisma/client';
import { RecoverPasswordDto } from './dto/recoverpassword.dto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { JWT_SECRET } from '../../config/jwt.config';

const prisma = new PrismaClient();

interface LoginInput {
  cpf?: string;
  cnpj?: string;
  password: string;
}

interface LoginResponse {
  access_token: string;
};



export class AuthService {
  public async login({ cpf, cnpj, password }: LoginInput): Promise<LoginResponse> {
    const document = cpf ?? cnpj;

    if (!document || !password) {
      throw new Error("CPF ou CNPJ e senha são obrigatórios.");
    }

    let user: User | null = null;

    if (cpf) {
      user = await prisma.user.findUnique({ where: { cpf } });
    } else if (cnpj) {
      user = await prisma.user.findUnique({ where: { cnpj } });
    }

    if (!user) {
      throw new Error("Usuário não encontrado.");
    }

    const passwordMatches = await bcrypt.compare(password, user.password);
    if (!passwordMatches) {
      throw new Error("Senha incorreta.");
    }

    const access_token = jwt.sign(
      {
        id: user.id,
        role: user.role,
        name: user.name,
        email: user.email,
        tv: user.tokenVersion,
      },
      JWT_SECRET,
      { expiresIn: '30d' }
    );

    return {
      access_token,
    };
  }

  public async logout(): Promise<{ message: string }> {

    return { message: 'Logout realizado com sucesso.' };
  }

  async recoverPassword(data: RecoverPasswordDto) {
    const { email, answer_1, answer_2, answer_3, newPassword } = data;

    const user = await prisma.user.findUnique({
      where: { email },
      include: { securityQuestions: true },
    });

    if (!user || !user.securityQuestions) {
      throw new Error('Usuário ou perguntas de segurança não encontrados');
    }

    const matches = await Promise.all([
      bcrypt.compare(answer_1, user.securityQuestions.answer_1),
      bcrypt.compare(answer_2, user.securityQuestions.answer_2),
      bcrypt.compare(answer_3, user.securityQuestions.answer_3),
    ]);

    if (!matches.every(Boolean)) {
      throw new Error('Respostas incorretas');
    }

    const hashed = await bcrypt.hash(newPassword, 10);

    await prisma.user.update({
      where: { id: user.id },
      data: {
        password: hashed,
        tokenVersion: { increment: 1 },
      },
    });

    return { message: 'Senha atualizada com sucesso' };
  }
}
