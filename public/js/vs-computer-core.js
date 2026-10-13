/**
 * Chess Home — ядро игры с компьютером
 *
 * Один файл работает в двух местах:
 *   1) на странице  (<script src="/js/vs-computer-core.js">)  → window.CHCore  — правила, SAN, FEN
 *   2) в Web Worker (importScripts)                         → считает ходы ботов, не вешая интерфейс
 *
 * Содержит: генератор ходов (0x88), make/unmake, Zobrist-хеш, оценку и поиск
 * (alpha-beta + quiescence + таблица транспозиций), настройки уровней ботов.
 * Внешних зависимостей нет (chess.js не нужен).
 */
(function (root) {
  'use strict';

  var WHITE = 0, BLACK = 1;
  var P = 1, N = 2, B = 3, R = 4, Q = 5, K = 6;
  var FILES = 'abcdefgh';
  var START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  var PIECE_CH = ' PNBRQK';

  function sqName(s) { return FILES[s & 7] + ((s >> 4) + 1); }
  function sqFrom(n) { return (n.charCodeAt(0) - 97) + ((n.charCodeAt(1) - 49) << 4); }

  var KNIGHT_OFF = [33, 31, 18, 14, -14, -18, -31, -33];
  var BISHOP_OFF = [17, 15, -15, -17];
  var ROOK_OFF = [16, 1, -1, -16];
  var KING_OFF = [16, 1, -1, -16, 17, 15, -15, -17];

  var CASTLE_MASK = new Int8Array(128).fill(15);
  CASTLE_MASK[0] = 13; CASTLE_MASK[4] = 12; CASTLE_MASK[7] = 14;
  CASTLE_MASK[112] = 7; CASTLE_MASK[116] = 3; CASTLE_MASK[119] = 11;

  // ── Zobrist ───────────────────────────────────────────────────────────────
  var _seed = 0x9e3779b9;
  function rnd32() {
    _seed ^= _seed << 13; _seed ^= _seed >>> 17; _seed ^= _seed << 5;
    return _seed | 0;
  }
  var zP = new Int32Array(16 * 128);
  for (var zi = 0; zi < zP.length; zi++) zP[zi] = rnd32();
  var zSide = rnd32();
  var zC = new Int32Array(16); for (zi = 0; zi < 16; zi++) zC[zi] = rnd32();
  var zEp = new Int32Array(8); for (zi = 0; zi < 8; zi++) zEp[zi] = rnd32();

  // ── Ходы: from | to<<7 | promo<<14 | flag<<17 ────────────────────────────
  // flag: 1 = взятие на проходе, 2 = короткая рокировка, 4 = длинная, 8 = двойной ход пешки
  function mk(from, to, promo, flag) { return from | (to << 7) | ((promo || 0) << 14) | ((flag || 0) << 17); }
  function mFrom(m) { return m & 127; }
  function mTo(m) { return (m >> 7) & 127; }
  function mPromo(m) { return (m >> 14) & 7; }
  function mFlag(m) { return (m >> 17) & 15; }
  function moveToUci(m) {
    var p = mPromo(m);
    return sqName(mFrom(m)) + sqName(mTo(m)) + (p ? 'nbrq'[p - 2] : '');
  }

  // ── Позиция ───────────────────────────────────────────────────────────────
  function Position() {
    this.board = new Int8Array(128);
    this.side = WHITE; this.castle = 0; this.ep = -1; this.half = 0; this.full = 1;
    this.kingSq = [4, 116];
    this.hash = 0;
    this.n = 0;
    this.uCap = new Int8Array(1024);
    this.uCastle = new Int8Array(1024);
    this.uEp = new Int16Array(1024);
    this.uHalf = new Int16Array(1024);
    this.uHash = new Int32Array(1024);
    this.setFEN(START_FEN);
  }

  Position.prototype.setFEN = function (fen) {
    var parts = fen.trim().split(/\s+/);
    var b = this.board; b.fill(0);
    var rows = parts[0].split('/');
    if (rows.length !== 8) throw new Error('bad fen');
    for (var r = 0; r < 8; r++) {
      var f = 0, row = rows[r];
      for (var i = 0; i < row.length; i++) {
        var ch = row[i];
        if (ch >= '1' && ch <= '8') { f += +ch; continue; }
        var low = ch.toLowerCase();
        var t = PIECE_CH.indexOf(low.toUpperCase());
        if (t < 1) throw new Error('bad fen piece');
        var color = ch === low ? BLACK : WHITE;
        var sq = (7 - r) * 16 + f;
        b[sq] = t | (color << 3);
        if (t === K) this.kingSq[color] = sq;
        f++;
      }
    }
    this.side = parts[1] === 'b' ? BLACK : WHITE;
    var c = 0, cs = parts[2] || '-';
    if (cs.indexOf('K') >= 0) c |= 1; if (cs.indexOf('Q') >= 0) c |= 2;
    if (cs.indexOf('k') >= 0) c |= 4; if (cs.indexOf('q') >= 0) c |= 8;
    this.castle = c;
    this.ep = (parts[3] && parts[3] !== '-') ? sqFrom(parts[3]) : -1;
    this.half = parseInt(parts[4], 10) || 0;
    this.full = parseInt(parts[5], 10) || 1;
    this.n = 0;
    this.hash = this.computeHash();
  };

  Position.prototype.computeHash = function () {
    var h = 0, b = this.board;
    for (var sq = 0; sq < 128; sq++) {
      if (sq & 0x88) { sq += 7; continue; }
      if (b[sq]) h ^= zP[b[sq] * 128 + sq];
    }
    if (this.side === BLACK) h ^= zSide;
    h ^= zC[this.castle];
    if (this.ep >= 0) h ^= zEp[this.ep & 7];
    return h | 0;
  };

  Position.prototype.getFEN = function () {
    var b = this.board, s = '';
    for (var r = 7; r >= 0; r--) {
      var empty = 0;
      for (var f = 0; f < 8; f++) {
        var p = b[r * 16 + f];
        if (!p) { empty++; continue; }
        if (empty) { s += empty; empty = 0; }
        var ch = PIECE_CH[p & 7];
        s += (p >> 3) ? ch.toLowerCase() : ch;
      }
      if (empty) s += empty;
      if (r) s += '/';
    }
    var c = '';
    if (this.castle & 1) c += 'K'; if (this.castle & 2) c += 'Q';
    if (this.castle & 4) c += 'k'; if (this.castle & 8) c += 'q';
    return s + ' ' + (this.side ? 'b' : 'w') + ' ' + (c || '-') + ' ' +
      (this.ep >= 0 ? sqName(this.ep) : '-') + ' ' + this.half + ' ' + this.full;
  };

  Position.prototype.isAttacked = function (sq, by) {
    var b = this.board, p, i, off, t;
    if (by === WHITE) {
      p = sq - 15; if (!(p & 0x88) && b[p] === P) return true;
      p = sq - 17; if (!(p & 0x88) && b[p] === P) return true;
    } else {
      p = sq + 15; if (!(p & 0x88) && b[p] === (P | 8)) return true;
      p = sq + 17; if (!(p & 0x88) && b[p] === (P | 8)) return true;
    }
    var cb = by << 3;
    for (i = 0; i < 8; i++) {
      p = sq + KNIGHT_OFF[i]; if (!(p & 0x88) && b[p] === (N | cb)) return true;
      p = sq + KING_OFF[i];   if (!(p & 0x88) && b[p] === (K | cb)) return true;
    }
    for (i = 0; i < 4; i++) {
      off = BISHOP_OFF[i]; p = sq + off;
      while (!(p & 0x88)) {
        t = b[p];
        if (t) { if (t === (B | cb) || t === (Q | cb)) return true; break; }
        p += off;
      }
      off = ROOK_OFF[i]; p = sq + off;
      while (!(p & 0x88)) {
        t = b[p];
        if (t) { if (t === (R | cb) || t === (Q | cb)) return true; break; }
        p += off;
      }
    }
    return false;
  };

  Position.prototype.inCheck = function () {
    return this.isAttacked(this.kingSq[this.side], this.side ^ 1);
  };

  Position.prototype.genMoves = function (capturesOnly) {
    var moves = [], b = this.board, us = this.side, them = us ^ 1;
    var dir = us === WHITE ? 16 : -16;
    var startRank = us === WHITE ? 1 : 6;
    var preRank = us === WHITE ? 6 : 1;
    var sq, p, t, to, target, i, off, d;
    for (sq = 0; sq < 128; sq++) {
      if (sq & 0x88) { sq += 7; continue; }
      p = b[sq];
      if (!p || (p >> 3) !== us) continue;
      t = p & 7;
      if (t === P) {
        to = sq + dir;
        if (!(to & 0x88) && !b[to]) {
          if ((sq >> 4) === preRank) {
            moves.push(mk(sq, to, Q, 0));
            if (!capturesOnly) { moves.push(mk(sq, to, R, 0)); moves.push(mk(sq, to, B, 0)); moves.push(mk(sq, to, N, 0)); }
          } else if (!capturesOnly) {
            moves.push(mk(sq, to, 0, 0));
            if ((sq >> 4) === startRank && !b[to + dir]) moves.push(mk(sq, to + dir, 0, 8));
          }
        }
        for (d = -1; d <= 1; d += 2) {
          to = sq + dir + d;
          if (to & 0x88) continue;
          target = b[to];
          if (target && (target >> 3) === them) {
            if ((sq >> 4) === preRank) {
              moves.push(mk(sq, to, Q, 0));
              if (!capturesOnly) { moves.push(mk(sq, to, R, 0)); moves.push(mk(sq, to, B, 0)); moves.push(mk(sq, to, N, 0)); }
            } else moves.push(mk(sq, to, 0, 0));
          } else if (to === this.ep && !target) {
            moves.push(mk(sq, to, 0, 1));
          }
        }
      } else if (t === N || t === K) {
        var offs = t === N ? KNIGHT_OFF : KING_OFF;
        for (i = 0; i < 8; i++) {
          to = sq + offs[i];
          if (to & 0x88) continue;
          target = b[to];
          if (!target) { if (!capturesOnly) moves.push(mk(sq, to, 0, 0)); }
          else if ((target >> 3) === them) moves.push(mk(sq, to, 0, 0));
        }
      } else {
        for (var k = 0; k < 8; k++) {
          // B: диагонали, R: прямые, Q: и те и другие
          if (t === B && k >= 4) break;
          if (t === R && k < 4) continue;
          off = k < 4 ? BISHOP_OFF[k] : ROOK_OFF[k - 4];
          to = sq + off;
          while (!(to & 0x88)) {
            target = b[to];
            if (!target) { if (!capturesOnly) moves.push(mk(sq, to, 0, 0)); }
            else { if ((target >> 3) === them) moves.push(mk(sq, to, 0, 0)); break; }
            to += off;
          }
        }
      }
    }
    if (!capturesOnly) {
      if (us === WHITE) {
        if (b[4] === K && !this.isAttacked(4, BLACK)) {
          if ((this.castle & 1) && b[7] === R && !b[5] && !b[6] &&
              !this.isAttacked(5, BLACK) && !this.isAttacked(6, BLACK)) moves.push(mk(4, 6, 0, 2));
          if ((this.castle & 2) && b[0] === R && !b[3] && !b[2] && !b[1] &&
              !this.isAttacked(3, BLACK) && !this.isAttacked(2, BLACK)) moves.push(mk(4, 2, 0, 4));
        }
      } else {
        if (b[116] === (K | 8) && !this.isAttacked(116, WHITE)) {
          if ((this.castle & 4) && b[119] === (R | 8) && !b[117] && !b[118] &&
              !this.isAttacked(117, WHITE) && !this.isAttacked(118, WHITE)) moves.push(mk(116, 118, 0, 2));
          if ((this.castle & 8) && b[112] === (R | 8) && !b[115] && !b[114] && !b[113] &&
              !this.isAttacked(115, WHITE) && !this.isAttacked(114, WHITE)) moves.push(mk(116, 114, 0, 4));
        }
      }
    }
    return moves;
  };

  Position.prototype.makeMove = function (m) {
    var b = this.board, from = m & 127, to = (m >> 7) & 127, promo = (m >> 14) & 7, flag = (m >> 17) & 15;
    var piece = b[from], cap = b[to], color = this.side, i = this.n;
    this.uCap[i] = cap; this.uCastle[i] = this.castle; this.uEp[i] = this.ep;
    this.uHalf[i] = this.half; this.uHash[i] = this.hash;
    this.n = i + 1;
    var h = this.hash;
    if (this.ep >= 0) h ^= zEp[this.ep & 7];
    b[from] = 0; h ^= zP[piece * 128 + from];
    if (cap) h ^= zP[cap * 128 + to];
    if (flag & 1) {
      var cs = to + (color === WHITE ? -16 : 16);
      cap = b[cs]; b[cs] = 0; h ^= zP[cap * 128 + cs];
      this.uCap[i] = cap;
    }
    var np = promo ? (promo | (color << 3)) : piece;
    b[to] = np; h ^= zP[np * 128 + to];
    var rook, rf, rt;
    if (flag & 2) { rf = from + 3; rt = from + 1; rook = b[rf]; b[rf] = 0; b[rt] = rook; h ^= zP[rook * 128 + rf] ^ zP[rook * 128 + rt]; }
    else if (flag & 4) { rf = from - 4; rt = from - 1; rook = b[rf]; b[rf] = 0; b[rt] = rook; h ^= zP[rook * 128 + rf] ^ zP[rook * 128 + rt]; }
    if ((piece & 7) === K) this.kingSq[color] = to;
    h ^= zC[this.castle];
    this.castle &= CASTLE_MASK[from] & CASTLE_MASK[to];
    h ^= zC[this.castle];
    this.ep = (flag & 8) ? ((from + to) >> 1) : -1;
    if (this.ep >= 0) h ^= zEp[this.ep & 7];
    this.half = ((piece & 7) === P || cap) ? 0 : this.half + 1;
    if (color === BLACK) this.full++;
    this.side = color ^ 1; h ^= zSide;
    this.hash = h | 0;
  };

  Position.prototype.unmake = function (m) {
    var b = this.board, from = m & 127, to = (m >> 7) & 127, promo = (m >> 14) & 7, flag = (m >> 17) & 15;
    var i = --this.n;
    var color = this.side ^ 1; this.side = color;
    var piece = promo ? (P | (color << 3)) : b[to];
    b[from] = piece;
    var cap = this.uCap[i];
    if (flag & 1) { b[to] = 0; b[to + (color === WHITE ? -16 : 16)] = cap; }
    else b[to] = cap;
    if (flag & 2) { b[from + 3] = b[from + 1]; b[from + 1] = 0; }
    else if (flag & 4) { b[from - 4] = b[from - 1]; b[from - 1] = 0; }
    if ((piece & 7) === K) this.kingSq[color] = from;
    this.castle = this.uCastle[i]; this.ep = this.uEp[i]; this.half = this.uHalf[i]; this.hash = this.uHash[i];
    if (color === BLACK) this.full--;
  };

  Position.prototype.legalMoves = function () {
    var pm = this.genMoves(false), out = [], us = this.side;
    for (var i = 0; i < pm.length; i++) {
      this.makeMove(pm[i]);
      if (!this.isAttacked(this.kingSq[us], us ^ 1)) out.push(pm[i]);
      this.unmake(pm[i]);
    }
    return out;
  };

  Position.prototype.parseUci = function (uci, legal) {
    legal = legal || this.legalMoves();
    for (var i = 0; i < legal.length; i++) if (moveToUci(legal[i]) === uci) return legal[i];
    return 0;
  };

  Position.prototype.sanOf = function (m, legal) {
    legal = legal || this.legalMoves();
    var b = this.board, from = mFrom(m), to = mTo(m), promo = mPromo(m), flag = mFlag(m);
    var t = b[from] & 7, s = '';
    if (flag & 2) s = 'O-O';
    else if (flag & 4) s = 'O-O-O';
    else {
      var isCap = !!b[to] || (flag & 1);
      if (t !== P) {
        s += PIECE_CH[t];
        var sameFile = false, sameRank = false, amb = false;
        for (var i = 0; i < legal.length; i++) {
          var x = legal[i];
          if (x === m || mTo(x) !== to || (b[mFrom(x)] & 7) !== t) continue;
          amb = true;
          if ((mFrom(x) & 7) === (from & 7)) sameFile = true;
          if ((mFrom(x) >> 4) === (from >> 4)) sameRank = true;
        }
        if (amb) {
          if (!sameFile) s += FILES[from & 7];
          else if (!sameRank) s += ((from >> 4) + 1);
          else s += FILES[from & 7] + ((from >> 4) + 1);
        }
      } else if (isCap) s += FILES[from & 7];
      if (isCap) s += 'x';
      s += sqName(to);
      if (promo) s += '=' + PIECE_CH[promo];
    }
    this.makeMove(m);
    if (this.inCheck()) s += this.legalMoves().length ? '+' : '#';
    this.unmake(m);
    return s;
  };

  Position.prototype.insufficientMaterial = function () {
    var b = this.board, minors = 0, bishopColors = 0, knights = 0;
    for (var sq = 0; sq < 128; sq++) {
      if (sq & 0x88) { sq += 7; continue; }
      var t = b[sq] & 7;
      if (!b[sq] || t === K) continue;
      if (t === P || t === R || t === Q) return false;
      minors++;
      if (t === N) knights++;
      else bishopColors |= 1 << (((sq >> 4) + (sq & 7)) & 1);
    }
    if (minors <= 1) return true;
    if (knights === 0 && bishopColors !== 3) return true; // только слоны одного цвета
    return false;
  };

  /** Хватает ли у стороны материала, чтобы теоретически поставить мат (для флага) */
  Position.prototype.canMate = function (color) {
    var b = this.board, minors = 0, knights = 0, bishopColors = 0;
    for (var sq = 0; sq < 128; sq++) {
      if (sq & 0x88) { sq += 7; continue; }
      var p = b[sq];
      if (!p || (p >> 3) !== color) continue;
      var t = p & 7;
      if (t === P || t === R || t === Q) return true;
      if (t === N) { knights++; minors++; }
      else if (t === B) { minors++; bishopColors |= 1 << (((sq >> 4) + (sq & 7)) & 1); }
    }
    if (minors >= 2) return true;
    return false;
  };

  Position.prototype.repetitionKey = function () {
    var f = this.getFEN().split(' ');
    return f[0] + ' ' + f[1] + ' ' + f[2] + ' ' + f[3];
  };

  // ── Оценка ────────────────────────────────────────────────────────────────
  var VAL = [0, 100, 320, 330, 500, 900, 0];
  var PST = {
    1: [0,0,0,0,0,0,0,0, 50,50,50,50,50,50,50,50, 10,10,20,30,30,20,10,10, 5,5,10,25,25,10,5,5,
        0,0,0,20,20,0,0,0, 5,-5,-10,0,0,-10,-5,5, 5,10,10,-20,-20,10,10,5, 0,0,0,0,0,0,0,0],
    2: [-50,-40,-30,-30,-30,-30,-40,-50, -40,-20,0,0,0,0,-20,-40, -30,0,10,15,15,10,0,-30, -30,5,15,20,20,15,5,-30,
        -30,0,15,20,20,15,0,-30, -30,5,10,15,15,10,5,-30, -40,-20,0,5,5,0,-20,-40, -50,-40,-30,-30,-30,-30,-40,-50],
    3: [-20,-10,-10,-10,-10,-10,-10,-20, -10,0,0,0,0,0,0,-10, -10,0,5,10,10,5,0,-10, -10,5,5,10,10,5,5,-10,
        -10,0,10,10,10,10,0,-10, -10,10,10,10,10,10,10,-10, -10,5,0,0,0,0,5,-10, -20,-10,-10,-10,-10,-10,-10,-20],
    4: [0,0,0,0,0,0,0,0, 5,10,10,10,10,10,10,5, -5,0,0,0,0,0,0,-5, -5,0,0,0,0,0,0,-5,
        -5,0,0,0,0,0,0,-5, -5,0,0,0,0,0,0,-5, -5,0,0,0,0,0,0,-5, 0,0,0,5,5,0,0,0],
    5: [-20,-10,-10,-5,-5,-10,-10,-20, -10,0,0,0,0,0,0,-10, -10,0,5,5,5,5,0,-10, -5,0,5,5,5,5,0,-5,
        0,0,5,5,5,5,0,-5, -10,5,5,5,5,5,0,-10, -10,0,5,0,0,0,0,-10, -20,-10,-10,-5,-5,-10,-10,-20],
    6: [-30,-40,-40,-50,-50,-40,-40,-30, -30,-40,-40,-50,-50,-40,-40,-30, -30,-40,-40,-50,-50,-40,-40,-30, -30,-40,-40,-50,-50,-40,-40,-30,
        -20,-30,-30,-40,-40,-30,-30,-20, -10,-20,-20,-20,-20,-20,-20,-10, 20,20,0,0,0,0,20,20, 20,30,10,0,0,10,30,20]
  };
  var KING_END = [-50,-40,-30,-20,-20,-30,-40,-50, -30,-20,-10,0,0,-10,-20,-30, -30,-10,20,30,30,20,-10,-30, -30,-10,30,40,40,30,-10,-30,
                  -30,-10,30,40,40,30,-10,-30, -30,-10,20,30,30,20,-10,-30, -30,-30,0,0,0,0,-30,-30, -50,-30,-30,-30,-30,-30,-30,-50];

  function centerDist(sq) { var f = sq & 7, r = sq >> 4; return Math.max(3 - f, f - 4) + Math.max(3 - r, r - 4); }

  /** Оценка в сантипешках с точки зрения стороны, которая ходит */
  function evaluate(pos) {
    var b = pos.board, score = [0, 0], npm = 0, bishops = [0, 0], pawnsLeft = [0, 0];
    var sq, p, t, c, idx;
    for (sq = 0; sq < 128; sq++) {
      if (sq & 0x88) { sq += 7; continue; }
      p = b[sq]; if (!p) continue;
      t = p & 7; c = p >> 3;
      if (t !== P && t !== K) npm += VAL[t];
      if (t === B) bishops[c]++;
      if (t === P) pawnsLeft[c]++;
    }
    var endgame = npm <= 2600;
    for (sq = 0; sq < 128; sq++) {
      if (sq & 0x88) { sq += 7; continue; }
      p = b[sq]; if (!p) continue;
      t = p & 7; c = p >> 3;
      idx = c === WHITE ? (7 - (sq >> 4)) * 8 + (sq & 7) : (sq >> 4) * 8 + (sq & 7);
      var v = VAL[t];
      if (t === K) v += endgame ? KING_END[idx] : PST[6][idx];
      else v += PST[t][idx];
      score[c] += v;
    }
    if (bishops[0] >= 2) score[0] += 30;
    if (bishops[1] >= 2) score[1] += 30;
    var s = score[0] - score[1];
    // добивание: если есть явное преимущество — загоняем короля соперника в угол
    if (endgame) {
      var w = score[0] - score[1];
      if (w > 250 && pawnsLeft[1] === 0) s += mop(pos, WHITE);
      else if (w < -250 && pawnsLeft[0] === 0) s -= mop(pos, BLACK);
    }
    s += pos.side === WHITE ? 10 : -10;
    return pos.side === WHITE ? s : -s;
  }
  function mop(pos, winner) {
    var wk = pos.kingSq[winner], lk = pos.kingSq[winner ^ 1];
    var dr = Math.abs((wk >> 4) - (lk >> 4)), df = Math.abs((wk & 7) - (lk & 7));
    return centerDist(lk) * 12 + (14 - (dr + df)) * 5;
  }

  // ── Поиск ─────────────────────────────────────────────────────────────────
  var MATE = 30000, INF = 32000;
  var TT_BITS = 18, TT_SIZE = 1 << TT_BITS, TT_MASK = TT_SIZE - 1;
  var ttKey = new Int32Array(TT_SIZE), ttMove = new Int32Array(TT_SIZE);
  var ttScore = new Int16Array(TT_SIZE), ttDepth = new Int8Array(TT_SIZE), ttFlag = new Int8Array(TT_SIZE);
  var killers = [], hist = new Int32Array(2 * 128 * 128);
  var nodes = 0, stopFlag = false, deadline = 0, useQ = true;

  function ttClear() { ttKey.fill(0); ttDepth.fill(-1); ttMove.fill(0); hist.fill(0); }

  function orderMoves(pos, moves, ttm, ply) {
    var b = pos.board, scores = new Array(moves.length), i, m, s, k1 = killers[ply] ? killers[ply][0] : 0, k2 = killers[ply] ? killers[ply][1] : 0;
    for (i = 0; i < moves.length; i++) {
      m = moves[i];
      if (m === ttm) { scores[i] = 1e7; continue; }
      var cap = b[(m >> 7) & 127], flag = (m >> 17) & 15, promo = (m >> 14) & 7;
      if (cap || (flag & 1)) {
        var victim = flag & 1 ? P : (cap & 7);
        s = 1e6 + VAL[victim] * 10 - VAL[b[m & 127] & 7] / 10;
      } else if (promo) s = 9e5 + VAL[promo];
      else if (m === k1) s = 8e5;
      else if (m === k2) s = 7e5;
      else s = hist[(pos.side * 128 + (m & 127)) * 128 + ((m >> 7) & 127)];
      scores[i] = s;
    }
    // сортировка вставками по убыванию (списки короткие)
    for (i = 1; i < moves.length; i++) {
      var mv = moves[i], sc = scores[i], j = i - 1;
      while (j >= 0 && scores[j] < sc) { moves[j + 1] = moves[j]; scores[j + 1] = scores[j]; j--; }
      moves[j + 1] = mv; scores[j + 1] = sc;
    }
    return moves;
  }

  function checkTime() {
    if ((nodes & 2047) === 0 && Date.now() >= deadline) stopFlag = true;
  }

  function quiesce(pos, alpha, beta, ply) {
    nodes++; checkTime();
    if (stopFlag) return 0;
    var stand = evaluate(pos);
    if (stand >= beta) return stand;
    if (stand > alpha) alpha = stand;
    if (ply > 40) return stand;
    var moves = orderMoves(pos, pos.genMoves(true), 0, ply), us = pos.side;
    for (var i = 0; i < moves.length; i++) {
      var m = moves[i];
      pos.makeMove(m);
      if (pos.isAttacked(pos.kingSq[us], us ^ 1)) { pos.unmake(m); continue; }
      var sc = -quiesce(pos, -beta, -alpha, ply + 1);
      pos.unmake(m);
      if (stopFlag) return 0;
      if (sc >= beta) return sc;
      if (sc > alpha) alpha = sc;
    }
    return alpha;
  }

  function isRepetition(pos) {
    var lim = Math.max(0, pos.n - pos.half);
    for (var i = pos.n - 2; i >= lim; i -= 2) if (pos.uHash[i] === pos.hash) return true;
    return false;
  }

  function negamax(pos, depth, alpha, beta, ply) {
    nodes++; checkTime();
    if (stopFlag) return 0;
    if (ply > 0) {
      if (pos.half >= 100 || isRepetition(pos)) return 0;
    }
    var us = pos.side;
    var inChk = pos.isAttacked(pos.kingSq[us], us ^ 1);
    if (inChk) depth++;
    if (depth <= 0) return useQ ? quiesce(pos, alpha, beta, ply) : evaluate(pos);
    var alpha0 = alpha, idx = pos.hash & TT_MASK, ttm = 0;
    if (ttKey[idx] === pos.hash && ttDepth[idx] >= 0) {
      ttm = ttMove[idx];
      if (ttDepth[idx] >= depth && ply > 0) {
        var ts = ttScore[idx];
        if (ts > MATE - 200) ts -= ply; else if (ts < -MATE + 200) ts += ply;
        var fl = ttFlag[idx];
        if (fl === 0) return ts;
        if (fl === 1 && ts >= beta) return ts;
        if (fl === 2 && ts <= alpha) return ts;
      }
    }
    var moves = orderMoves(pos, pos.genMoves(false), ttm, ply);
    var best = -INF, bestMove = 0, legal = 0;
    if (!killers[ply]) killers[ply] = [0, 0];
    for (var i = 0; i < moves.length; i++) {
      var m = moves[i];
      pos.makeMove(m);
      if (pos.isAttacked(pos.kingSq[us], us ^ 1)) { pos.unmake(m); continue; }
      legal++;
      var quiet = !pos.uCap[pos.n - 1] && !((m >> 14) & 7) && !((m >> 17) & 1);
      var sc;
      if (legal > 4 && depth >= 3 && !inChk && quiet) {
        sc = -negamax(pos, depth - 2, -alpha - 1, -alpha, ply + 1);
        if (sc > alpha && !stopFlag) sc = -negamax(pos, depth - 1, -beta, -alpha, ply + 1);
      } else {
        sc = -negamax(pos, depth - 1, -beta, -alpha, ply + 1);
      }
      pos.unmake(m);
      if (stopFlag) return 0;
      if (sc > best) { best = sc; bestMove = m; }
      if (sc > alpha) {
        alpha = sc;
        if (alpha >= beta) {
          if (quiet) {
            if (killers[ply][0] !== m) { killers[ply][1] = killers[ply][0]; killers[ply][0] = m; }
            hist[(us * 128 + (m & 127)) * 128 + ((m >> 7) & 127)] += depth * depth;
          }
          break;
        }
      }
    }
    if (!legal) return inChk ? -MATE + ply : 0;
    var flag = best >= beta ? 1 : (best > alpha0 ? 0 : 2);
    var store = best;
    if (store > MATE - 200) store += ply; else if (store < -MATE + 200) store -= ply;
    if (ttDepth[idx] <= depth || ttKey[idx] !== pos.hash) {
      ttKey[idx] = pos.hash; ttMove[idx] = bestMove; ttScore[idx] = store; ttDepth[idx] = depth; ttFlag[idx] = flag;
    }
    return best;
  }

  /**
   * Выбор хода ботом.
   * cfg: { depth, timeMs, noise, blunder, quiesce }
   *   depth   — максимальная глубина перебора
   *   timeMs  — лимит времени на ход
   *   noise   — случайная «погрешность» оценки каждого хода в сантипешках (слабые боты)
   *   blunder — вероятность сыграть случайный легальный ход
   *   quiesce — досчитывать цепочки взятий (слабые боты — нет)
   */
  function chooseMove(pos, cfg) {
    var legal = pos.legalMoves();
    if (!legal.length) return null;
    if (legal.length === 1) return { move: legal[0], score: 0, depth: 0 };
    nodes = 0; stopFlag = false; useQ = cfg.quiesce !== false;
    deadline = Date.now() + (cfg.timeMs || 1000);
    killers = [];
    var us = pos.side, i, m;

    if (cfg.blunder && Math.random() < cfg.blunder) {
      return { move: legal[Math.floor(Math.random() * legal.length)], score: 0, depth: 0 };
    }

    // Слабые уровни: оцениваем каждый ход на фиксированную глубину и подмешиваем шум
    if (cfg.noise) {
      var bestM = legal[0], bestS = -Infinity;
      for (i = 0; i < legal.length; i++) {
        m = legal[i];
        pos.makeMove(m);
        var s;
        var replies = pos.legalMoves();
        if (!replies.length) s = pos.inCheck() ? MATE : 0;
        else s = -negamax(pos, Math.max(0, cfg.depth - 1), -INF, INF, 1);
        pos.unmake(m);
        if (stopFlag) { stopFlag = false; deadline = Date.now() + 200; }
        s += (Math.random() * 2 - 1) * cfg.noise;
        if (s > bestS) { bestS = s; bestM = m; }
      }
      return { move: bestM, score: bestS, depth: cfg.depth };
    }

    // Сильные уровни: итеративное углубление
    var bestMove = legal[0], bestScore = 0, doneDepth = 0;
    var maxD = cfg.depth || 6;
    for (var d = 1; d <= maxD; d++) {
      var alpha = -INF, beta = INF, iterBest = 0, iterScore = -INF;
      var ordered = orderMoves(pos, legal.slice(), bestMove, 0);
      for (i = 0; i < ordered.length; i++) {
        m = ordered[i];
        pos.makeMove(m);
        var sc = -negamax(pos, d - 1, -beta, -alpha, 1);
        pos.unmake(m);
        if (stopFlag) break;
        if (sc > iterScore) { iterScore = sc; iterBest = m; }
        if (sc > alpha) alpha = sc;
      }
      if (stopFlag) {
        // частично пройденную итерацию учитываем, только если ход улучшил результат прошлой
        if (iterBest && iterScore > bestScore + 50 && d > 1) { bestMove = iterBest; bestScore = iterScore; }
        break;
      }
      bestMove = iterBest; bestScore = iterScore; doneDepth = d;
      if (Math.abs(bestScore) > MATE - 100) break;
      if (Date.now() >= deadline) break;
    }
    return { move: bestMove, score: bestScore, depth: doneDepth, nodes: nodes };
  }

  // ── Уровни ботов ──────────────────────────────────────────────────────────
  var BOTS = {
    pawnik:  { id: 'pawnik',  name: 'Пешкин',      level: 'Новичок', stars: 1, icon: '🐣', engine: 'own',
               desc: 'Смотрит на один ход вперёд и часто зевает фигуры. Для самых первых партий.',
               cfg: { depth: 1, timeMs: 300,  noise: 320, blunder: 0.22, quiesce: false } },
    zevaka:  { id: 'zevaka',  name: 'Зевака',      level: 'Слабый',  stars: 2, icon: '🐢', engine: 'own',
               desc: 'Видит простые размены, но пропускает тактику на пару ходов.',
               cfg: { depth: 2, timeMs: 500,  noise: 110, blunder: 0.07, quiesce: false } },
    taktik:  { id: 'taktik',  name: 'Тактик',      level: 'Средний', stars: 3, icon: '⚔️', engine: 'own',
               desc: 'Считает на несколько ходов, ловит вилки и связки, но стратегия — не его конёк.',
               cfg: { depth: 3, timeMs: 1500, noise: 25,  blunder: 0,    quiesce: true } },
    maestro: { id: 'maestro', name: 'Маэстро',     level: 'Высокий', stars: 4, icon: '🎓', engine: 'own',
               desc: 'Глубокий перебор и аккуратная оценка позиции. Ошибается редко.',
               cfg: { depth: 8, timeMs: 2500, noise: 0,   blunder: 0,    quiesce: true } },
    sf16:    { id: 'sf16',    name: 'Stockfish 16', level: 'Экстрим', stars: 5, icon: '🔥', engine: 'stockfish',
               desc: 'Сильнейший шахматный движок. Считает прямо в вашем браузере (WebAssembly).',
               cfg: {} }
  };

  // ── Экспорт ───────────────────────────────────────────────────────────────
  var api = {
    WHITE: WHITE, BLACK: BLACK, START_FEN: START_FEN, BOTS: BOTS,
    Position: Position, moveToUci: moveToUci, sqName: sqName, sqFrom: sqFrom,
    mFrom: mFrom, mTo: mTo, mPromo: mPromo, mFlag: mFlag,
    chooseMove: chooseMove, evaluate: evaluate, ttClear: ttClear
  };
  root.CHCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;

  // ── Режим Web Worker ──────────────────────────────────────────────────────
  if (typeof WorkerGlobalScope !== 'undefined' && root instanceof WorkerGlobalScope) {
    var wpos = new Position();
    root.onmessage = function (e) {
      var d = e.data || {};
      if (d.type === 'newgame') { ttClear(); return; }
      if (d.type !== 'go') return;
      try {
        wpos.setFEN(d.startFen || START_FEN);
        var mv = d.moves || [];
        for (var i = 0; i < mv.length; i++) {
          var m = wpos.parseUci(mv[i]);
          if (!m) throw new Error('illegal move in history: ' + mv[i]);
          wpos.makeMove(m);
        }
        var res = chooseMove(wpos, d.cfg || {});
        root.postMessage({ type: 'move', id: d.id, uci: res ? moveToUci(res.move) : null,
          score: res ? res.score : 0, depth: res ? res.depth : 0 });
      } catch (err) {
        root.postMessage({ type: 'error', id: d.id, message: String(err && err.message || err) });
      }
    };
  }
})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : this));
