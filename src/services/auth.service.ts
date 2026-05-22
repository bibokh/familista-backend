import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import { User, UserRole } from '@prisma/client';
import { prisma } from '../config/database';
import { config } from '../config';
import {
  UnauthorizedError,
  ConflictError,
  NotFoundError,
  BadRequestError,
} from '../utils/errors';
import { logger } from '../utils/logger';

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

export interface AuthUser {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: UserRole;
  clubId: string;
  clubName: string;
}

interface JwtPayload {
  sub: string;
  email: string;
  role: UserRole;
  clubId: string;
}

// ── Token generation ──────────────────────────────────────

function generateAccessToken(payload: JwtPayload): string {
  return jwt.sign(payload, config.jwt.secret, {
    expiresIn: config.jwt.expiresIn,
  } as jwt.SignOptions);
}

function generateRefreshToken(payload: JwtPayload): string {
  return jwt.sign(payload, config.jwt.refreshSecret, {
    expiresIn: config.jwt.refreshExpiresIn,
  } as jwt.SignOptions);
}

function getRefreshExpiry(): Date {
  const d = new Date();
  d.setDate(d.getDate() + 7); // 7 days
  return d;
}

// ── Register ──────────────────────────────────────────────

export async function registerUser(data: {
  email: string;
  password: string;
  firstName: string;
  lastName: string;
  role?: UserRole;
  clubId: string;
}): Promise<{ user: AuthUser; tokens: TokenPair }> {
  // Check duplicate
  const existing = await prisma.user.findUnique({ where: { email: data.email } });
  if (existing) throw new ConflictError('Email already registered');

  // Verify club exists
  const club = await prisma.club.findUnique({ where: { id: data.clubId } });
  if (!club) throw new NotFoundError('Club');

  // Hash password
  const passwordHash = await bcrypt.hash(data.password, 12);

  const user = await prisma.user.create({
    data: {
      email: data.email.toLowerCase().trim(),
      passwordHash,
      firstName: data.firstName.trim(),
      lastName: data.lastName.trim(),
      role: data.role ?? UserRole.HEAD_COACH,
      clubId: data.clubId,
    },
    include: { club: { select: { name: true } } },
  });

  const tokens = await issueTokens(user);
  logger.info('User registered', { userId: user.id, clubId: user.clubId });

  return {
    user: mapAuthUser(user, user.club.name),
    tokens,
  };
}

// ── Login ─────────────────────────────────────────────────

export async function loginUser(
  email: string,
  password: string
): Promise<{ user: AuthUser; tokens: TokenPair }> {
  const user = await prisma.user.findUnique({
    where: { email: email.toLowerCase().trim() },
    include: { club: { select: { name: true } } },
  });

  if (!user || !user.isActive) {
    throw new UnauthorizedError('Invalid email or password');
  }

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) throw new UnauthorizedError('Invalid email or password');

  // Update last login
  await prisma.user.update({
    where: { id: user.id },
    data: { lastLoginAt: new Date() },
  });

  const tokens = await issueTokens(user);
  logger.info('User logged in', { userId: user.id });

  return { user: mapAuthUser(user, user.club.name), tokens };
}

// ── Refresh ───────────────────────────────────────────────

export async function refreshTokens(token: string): Promise<TokenPair> {
  let payload: JwtPayload;
  try {
    payload = jwt.verify(token, config.jwt.refreshSecret) as JwtPayload;
  } catch {
    throw new UnauthorizedError('Invalid refresh token');
  }

  const stored = await prisma.refreshToken.findUnique({ where: { token } });
  if (!stored || stored.expiresAt < new Date()) {
    throw new UnauthorizedError('Refresh token expired or revoked');
  }

  const user = await prisma.user.findFirst({
    where: { id: payload.sub, isActive: true },
    include: { club: { select: { name: true } } },
  });
  if (!user) throw new UnauthorizedError('User not found');

  // Rotate: delete old, issue new
  await prisma.refreshToken.delete({ where: { token } });
  return issueTokens(user);
}

// ── Logout ────────────────────────────────────────────────

export async function logoutUser(refreshToken: string): Promise<void> {
  await prisma.refreshToken.deleteMany({ where: { token: refreshToken } });
}

// ── Change password ───────────────────────────────────────

export async function changePassword(
  userId: string,
  currentPassword: string,
  newPassword: string
): Promise<void> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new NotFoundError('User');

  const valid = await bcrypt.compare(currentPassword, user.passwordHash);
  if (!valid) throw new BadRequestError('Current password is incorrect');

  const hash = await bcrypt.hash(newPassword, 12);
  await prisma.user.update({ where: { id: userId }, data: { passwordHash: hash } });

  // Revoke all refresh tokens
  await prisma.refreshToken.deleteMany({ where: { userId } });
  logger.info('Password changed', { userId });
}

// ── Helpers ───────────────────────────────────────────────

async function issueTokens(user: User): Promise<TokenPair> {
  const payload: JwtPayload = {
    sub: user.id,
    email: user.email,
    role: user.role,
    clubId: user.clubId,
  };

  const accessToken = generateAccessToken(payload);
  const refreshToken = generateRefreshToken(payload);

  await prisma.refreshToken.create({
    data: {
      token: refreshToken,
      userId: user.id,
      expiresAt: getRefreshExpiry(),
    },
  });

  return { accessToken, refreshToken };
}

function mapAuthUser(
  user: User,
  clubName: string
): AuthUser {
  return {
    id: user.id,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    role: user.role,
    clubId: user.clubId,
    clubName,
  };
}
