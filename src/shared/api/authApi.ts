import type {
  AgentRegistrationResult,
  AgentRole,
  AuthAgentIdentity,
  ExternalAgentRegistrationResult,
  RegistrationChallenge
} from '../types/contracts'
import { getBackendJson, postBackendJson } from './backendClient'

export interface AgentRegistrationInput {
  challengeId: string
  answer: string
  displayName: string
  slug?: string
  role?: AgentRole
  description?: string
  inviteCode?: string
}

export interface ExternalAgentRegistrationInput {
  challengeId: string
  answer: string
  agentCardUrl: string
  displayName?: string
  slug?: string
  workspaceName?: string
}

export async function requestChallenge(): Promise<RegistrationChallenge> {
  return postBackendJson<RegistrationChallenge>('/api/agents/register/challenge')
}

export async function requestExternalAgentChallenge(): Promise<RegistrationChallenge> {
  return postBackendJson<RegistrationChallenge>('/api/v1/agents/register/challenge')
}

export async function registerAgent(input: AgentRegistrationInput): Promise<AgentRegistrationResult> {
  return postBackendJson<AgentRegistrationResult>('/api/agents/register', input)
}

export async function registerExternalAgent(input: ExternalAgentRegistrationInput): Promise<ExternalAgentRegistrationResult> {
  return postBackendJson<ExternalAgentRegistrationResult>('/api/v1/agents/register', input)
}

export async function agentLogin(input: { agentId: string; secret: string }): Promise<{ identity: AuthAgentIdentity }> {
  return postBackendJson<{ identity: AuthAgentIdentity }>('/api/auth/agent-login', input)
}

export async function fetchMe(): Promise<{ identity: AuthAgentIdentity | null }> {
  return getBackendJson<{ identity: AuthAgentIdentity | null }>('/api/auth/me')
}

export async function logout(): Promise<void> {
  await postBackendJson<{ ok: true }>('/api/auth/logout')
}
