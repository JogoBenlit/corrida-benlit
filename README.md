# 🏁 Corrida Benlit

Jogo de corrida multiplayer online que roda no navegador (iPhone, Android, tablet e computador).
Você cria uma sala, manda o link no WhatsApp e a galera entra direto, sem instalar nada.

## Como funciona (arquitetura)

```
 Celulares / PCs (navegador)            Servidor Node.js (um único serviço)
 ┌──────────────────────────┐          ┌──────────────────────────────────┐
 │ Canvas 2D (pista, carros)│◀──WS────▶│ Socket.IO: salas, lobby, largada │
 │ Física do próprio carro  │  20x/s   │ Valida cada movimento            │
 │ Interpolação dos outros  │          │ Conta setores, voltas e chegada  │
 └──────────────────────────┘          │ Calcula ranking e pontos         │
                                       │ Serve os arquivos do jogo        │
                                       └──────────────────────────────────┘
```

- **Um único serviço** serve o site e o multiplayer. Não precisa de Vercel/Netlify separado, nem configurar CORS.
- Cada jogador simula o próprio carro (resposta imediata ao toque) e envia a posição 20 vezes por segundo.
- **O servidor é quem manda no resultado.** Ele recusa movimentos impossíveis (velocidade acima do limite, atalho cortando o gramado, posição fora das barreiras) e devolve o carro para a última posição válida. As voltas são contadas pelo servidor, setor por setor, na ordem. Não existe nenhuma mensagem do tipo "eu venci": a chegada é detectada no servidor.
- Os carros dos outros são desenhados com ~110 ms de atraso e interpolados, para ficarem suaves mesmo com internet oscilando.

## Estrutura de pastas

```
corrida-benlit/
├── server.js                 # servidor: salas, validação, voltas, resultados
├── package.json
├── render.yaml               # (opcional) blueprint para publicar no Render
├── test/
│   └── multiplayer.test.js   # teste automático com pilotos-robô
└── public/                   # front-end (servido pelo próprio servidor)
    ├── index.html            # telas: início, lobby, corrida, resultados
    ├── style.css             # visual responsivo + áreas seguras do iPhone
    ├── config.js             # só usado se hospedar o front-end separado
    ├── shared/track.js       # pista (mesmo arquivo no servidor e no navegador)
    ├── js/game.js            # física, desenho, partículas, minimapa, HUD
    ├── js/input.js           # teclado + toque multitoque
    ├── js/audio.js           # sons e música sintetizados (Web Audio)
    ├── js/main.js            # telas, conexão, convites, reconexão
    └── assets/               # logo e leão da Benlit
```

## Rodar no seu computador

Pré-requisito: [Node.js 18 ou mais novo](https://nodejs.org) (recomendado 20 LTS).

```bash
cd corrida-benlit
npm install
npm start
```

Abra **http://localhost:3000**.

Para rodar o teste automático do multiplayer (sobe o servidor e conecta pilotos-robô):

```bash
npm test
```

## Testar o multiplayer em casa

**Duas abas no mesmo computador:** abra `http://localhost:3000` em uma aba, crie a sala, copie o link e abra em outra aba (ou outro navegador). Cada aba é um jogador diferente.

**Celular na mesma rede Wi-Fi:**
1. Descubra o IP do computador (Windows: `ipconfig`; Mac: Preferências > Rede; Linux: `hostname -I`). Exemplo: `192.168.0.15`.
2. No celular, abra `http://192.168.0.15:3000`.
3. Se o Windows perguntar sobre o Firewall, permita o Node.js em redes privadas.

Observação: em `http://` de rede local o botão "Copiar link" usa um método alternativo e o compartilhamento nativo pode não aparecer. Na versão publicada (https) tudo funciona normalmente.

## Publicar na internet (grátis) — Render

O Render tem plano gratuito para serviços Node.js com WebSocket. Passo a passo:

1. Crie uma conta no [GitHub](https://github.com) e um repositório novo (pode ser privado), por exemplo `corrida-benlit`.
2. Envie os arquivos do projeto para o repositório (pelo site: "Add file > Upload files", arrastando o conteúdo da pasta, **sem** a pasta `node_modules`).
3. Crie uma conta no [Render](https://render.com) entrando com o GitHub.
4. Clique em **New + > Web Service** e escolha o repositório.
5. Preencha:
   - **Runtime:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** Free
6. Clique em **Create Web Service** e aguarde o deploy (2–4 minutos).
7. O Render mostra um endereço como `https://corrida-benlit.onrender.com`. **Esse é o link do jogo.**

Alternativa: em **New + > Blueprint**, aponte para o repositório e o Render lê o `render.yaml` sozinho.

Não há senha nem chave secreta no projeto. Nada precisa ser configurado em variáveis de ambiente.

### Limitações do plano gratuito do Render (confira as regras atuais no site deles)
- O servidor **"dorme" após uns 15 minutos sem acesso**. O primeiro acesso depois disso demora cerca de 1 minuto para acordar. Dica: abra o link uns minutos antes do campeonato.
- Quando o servidor reinicia ou dorme, as salas e o ranking do campeonato são apagados (ficam só na memória).
- O servidor gratuito fica nos EUA ou Europa. Do Brasil o ping costuma ficar entre 120 e 200 ms — o jogo foi feito para isso (seu carro responde na hora; os outros são suavizados).
- Há um limite mensal de horas gratuitas, suficiente para uso entre amigos.

Outras opções que também suportam WebSocket: Railway e Fly.io (com créditos/limites próprios), ou qualquer VPS com Node.

### Hospedar o front-end separado (opcional)
Só se você quiser o site em Netlify/Vercel e o servidor no Render:
1. Em `public/config.js`, coloque `window.CORRIDA_SERVER_URL = 'https://SEU-SERVIDOR.onrender.com';`
2. No Render, crie a variável de ambiente `ALLOWED_ORIGINS` com o endereço do site (ex.: `https://corrida-benlit.netlify.app`).
3. Publique a pasta `public/` no Netlify/Vercel.

Para a primeira versão, **recomendo não separar**: um serviço só é mais simples e mais estável.

## Como chamar a galera

1. Abra o link do jogo, digite seu apelido e toque em **Criar sala**.
2. No lobby, toque em **Enviar no WhatsApp** (ou **Convidar amigos** / **Copiar link**). O link tem o formato `https://...onrender.com/?sala=ABCD`.
3. Quem abrir o link vê "Entrar na sala ABCD": digita o apelido, escolhe a cor e entra.
4. Você (anfitrião) escolhe o número de voltas e toca em **Iniciar corrida**.
5. No fim, aparece o pódio. O anfitrião toca em **Jogar novamente** para a próxima. Os pontos (10, 8, 6, 5, 4, 3, 2, 1) somam no **Campeonato da sala**.

Também dá para entrar digitando o código de 4 letras na tela inicial.

## Controles

| Ação | Computador | Celular |
|---|---|---|
| Acelerar | W ou ↑ | botão Acelerar |
| Freio / ré | S ou ↓ | botão Freio |
| Virar | A/D ou ←/→ | setas à esquerda |
| Drift (freio de mão) | Espaço | botão Drift |
| Nitro | Shift ou N | botão Nitro |

O nitro recarrega devagar sozinho e mais rápido quando você faz drift. Grama deixa o carro lento; barreiras e pilhas de pneus fazem o carro quicar.

## O que foi implementado

- Salas privadas com código de 4 letras e link compartilhável; 1 a 8 pilotos por sala (pode largar sozinho para treinar).
- Lobby com lista de pilotos, cores sem repetição, anfitrião, escolha de voltas (1, 2, 3 ou 5) e campeonato.
- Contagem 3, 2, 1, VAI! sincronizada; cronômetro; volta atual; posição ao vivo; melhor volta; aviso de "Última volta" e "Contramão".
- Física arcade: aceleração, freio, ré, direção, derrapagem, freio de mão, nitro, grama, colisão com barreiras, pneus e outros carros.
- Efeitos: fumaça de pneu, poeira na grama, faíscas nas batidas, chama do nitro, marcas de pneu que ficam no asfalto, tremor de câmera.
- Sons de motor (com troca de marcha), derrapagem, batida, largada e chegada; música opcional. Tudo sintetizado, sem arquivos.
- Desconexão: aviso para todos, 60 segundos para voltar com o mesmo carro e posição (inclusive recarregando a página). Se o anfitrião sair, outro assume. Se alguém cair, a corrida continua.
- Depois que o 1º colocado chega, os demais têm 30 segundos para terminar.
- Celular: controles multitoque nas laterais, áreas seguras do iPhone (notch e barra de gestos), retrato e paisagem, aviso para deitar o celular (sem bloquear), bloqueio de zoom e rolagem durante a corrida, tela cheia no Android, tela não apaga durante a corrida (onde o navegador permite), qualidade gráfica reduzida automaticamente em aparelhos mais fracos.

## O que foi testado (e o que não foi)

Testado automaticamente aqui:
- `npm test`: 14 verificações com pilotos-robô conectados ao servidor real — criação e entrada em sala, permissões do anfitrião, largada sincronizada, rejeição de teleporte/atalho/posição fora da pista, queda e reconexão no meio da corrida, voltas, chegada, pontos, troca de anfitrião, revanche e limite de 8 pilotos.
- Navegador Chromium automatizado com emulação de **iPhone 13 (deitado)**, **Pixel 7 (em pé)**, **Galaxy S9+** e desktop na mesma sala: entrada pelo link, corrida completa até o pódio, "Jogar novamente", multitoque (acelerar + virar ao mesmo tempo e soltar corretamente), queda forçada de conexão e recarregar a página no meio da corrida. Sem erros de JavaScript.

**Não testado em aparelhos físicos.** A emulação do Chromium não é o Safari real do iPhone. Antes do campeonato, faça a lista abaixo com celulares de verdade.

## Lista de testes com aparelhos reais

1. [ ] iPhone (Safari): abrir o link pelo WhatsApp, entrar na sala, escolher cor.
2. [ ] Android (Chrome): idem.
3. [ ] Computador: criar sala, ver os dois celulares no lobby.
4. [ ] Iniciar corrida: a contagem aparece ao mesmo tempo em todos.
5. [ ] No celular: segurar Acelerar e virar ao mesmo tempo; soltar e ver o carro parar de acelerar.
6. [ ] Girar o celular durante a corrida (retrato ↔ paisagem): a tela se ajusta e os botões continuam funcionando.
7. [ ] Todos veem os mesmos carros andando (conferir no minimapa).
8. [ ] Desligar o Wi-Fi de um celular por ~5 s e religar: aparece "Reconectando…", depois "Conexão restabelecida", e o carro volta à corrida.
9. [ ] Trocar para o WhatsApp no meio da corrida e voltar em menos de 1 minuto.
10. [ ] Terminar a corrida: pódio aparece para todos; anfitrião toca em "Jogar novamente".
11. [ ] Fechar a aba do anfitrião no lobby: outro jogador vira anfitrião em até ~1 minuto.
12. [ ] Som: no iPhone, desligar a chave de silencioso (com ela ligada o Safari pode não tocar o som do jogo).

## Ajustes rápidos

- **Velocidade dos carros:** `MAX_SPEED` e `NITRO_SPEED` em `public/shared/track.js` (o servidor usa os mesmos valores).
- **Traçado da pista:** `CONTROL_POINTS` em `public/shared/track.js`. Mantenha trechos paralelos a pelo menos ~350 unidades de distância.
- **Tempo para terminar após o vencedor:** `FINISH_TIMEOUT_MS` em `server.js`.
- **Pontuação:** `POINTS` em `server.js`.
- **Cores dos carros:** `COLORS` em `server.js` (e `DEFAULT_COLORS` em `public/js/game.js`).
