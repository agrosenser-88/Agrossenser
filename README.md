# AgroSensor Tech

Sistema web (PWA) em português do Brasil para gestão agrícola: fazendas e talhões, mapa, AgroSensor IA, pragas e doenças, máquinas, drones, pulverização, clima, sensores/IoT, relatórios (PDF/CSV), custos e economia, alertas, usuários e configurações.

## Requisitos
- Node.js **22.13 ou superior** (usa o SQLite embutido do Node). Não há dependências npm para instalar.

## Executar
```sh
npm start            # http://localhost:3000
```
Primeiro acesso: usuário **admin**, senha **admin123** (criados só se o banco estiver vazio).
**Troque a senha** em Configurações > Segurança, ou defina `ADMIN_PASSWORD` no `.env` antes da primeira execução (copie `.env.example`).

Comandos úteis:
```sh
npm test                                   # testes automatizados da API
npm run create-user -- joao senha12345 operador João
npm run reset-password -- admin novasenha123
npm run backup                             # banco + fotos em backups/AAAAMMDD-HHMMSS
```

## Publicar (servidor próprio)
1. Copie a pasta, crie `.env` com `NODE_ENV=production` e `ADMIN_PASSWORD`.
2. Rode `npm start` sob um gerenciador (systemd, pm2 ou Docker) atrás de HTTPS (nginx/Caddy). HTTPS é necessário para instalar o PWA e usar GPS no celular.
3. Persistência: guarde `DATA_DIR` (padrão `./data`) em disco permanente. **O backup deve incluir o banco e a pasta `uploads`** (`npm run backup` faz os dois).

## Integrações
| Integração | Estado | Como ativar |
|---|---|---|
| Clima (Open-Meteo) | ativa, sem chave | Fazenda precisa de latitude/longitude. Se a fonte falhar, a tela diz "indisponível" |
| AgroSensor IA | pendente | `ANTHROPIC_API_KEY` no `.env` (fica só no servidor). Sem chave, a foto é salva e o status é "indisponível". A IA apenas sugere; nada é registrado sem confirmação |
| E-mail (redefinir senha) | pendente | `SMTP_*` no `.env`. Sem SMTP, o administrador gera um link de redefinição |
| Sensores | pronto para receber | `POST /api/ingest/<device_id>` com cabeçalho `X-Device-Key` (chave mostrada uma única vez ao cadastrar). Sem leitura real: "Aguardando conexão" |
| Push, rastreio GPS de máquinas, SDK de drones, MQTT, taxa variável, Play Store | **não implementados** | Fora do escopo desta versão |

## Regras de honestidade dos dados
- Nenhum dado de clima, sensor ou IA é inventado. Leituras de demonstração são marcadas e ficam fora de relatórios e alertas.
- Economia (%) = ((referência − atual) / referência) × 100, só com custos e área reais cadastrados; sem dados suficientes o sistema informa isso.
- O sistema não controla drones nem máquinas.

## Segurança e LGPD
Senhas com scrypt; sessões no banco (cookie HttpOnly); proteção CSRF; bloqueio após 5 tentativas; isolamento por organização; perfis e restrição por fazenda; validação no servidor; consultas parametrizadas; envio de arquivos com verificação de assinatura (SVG/HTML recusados); log de auditoria. Dados pessoais tratados: nome, usuário, e-mail e registros operacionais, usados só para operar o sistema; o administrador pode exportar (backup) e excluir dados. Antes de uso comercial, publique uma política de privacidade própria com o controlador dos dados.

## Estrutura
`server/` API e banco (migrations em `server/migrations`) · `public/` interface (ES modules, sem build) · `test/` testes · `scripts/` utilitários.
