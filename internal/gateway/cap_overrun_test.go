package gateway

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"maps"
	"math"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/yetone/magpie/internal/provider"
)

// accountsBackend is a ChatGPT backend with several accounts, by
// chatgpt-account-id, each turn spending what cost says of its five hours
// for the request's body, counted as the turn ends. It tells the usage as
// ChatGPT does: in whole percents, in the x-codex-* headers of a reply as
// it begins (without its own turn), and at /wham/usage. silent: its
// replies say nothing of the usage, which /wham/usage alone tells.
type accountsBackend struct {
	mu         sync.Mutex
	used       map[string]float64
	turns      map[string]int
	cost       func(body []byte) float64
	five, week int64
	silent     bool
}

func newAccountsBackend(t *testing.T, used map[string]float64, cost func([]byte) float64, hold time.Duration) *accountsBackend {
	t.Helper()
	now := time.Now()
	b := &accountsBackend{used: used, turns: map[string]int{}, cost: cost,
		five: now.Add(2 * time.Hour).Unix(), week: now.Add(4 * 24 * time.Hour).Unix()}
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		acct := r.Header.Get("chatgpt-account-id")
		switch r.URL.Path {
		case "/backend-api/codex/responses":
			body, _ := io.ReadAll(r.Body)
			b.mu.Lock()
			told := math.Floor(b.used[acct])
			if told >= 100 {
				b.mu.Unlock()
				w.WriteHeader(429)
				io.WriteString(w, `{"error":{"type":"usage_limit_reached","message":"The usage limit has been reached","resets_in_seconds":7200}}`)
				return
			}
			b.turns[acct]++
			silent := b.silent
			b.mu.Unlock()
			if !silent {
				w.Header().Set("x-codex-primary-used-percent", strconv.FormatFloat(told, 'f', -1, 64))
				w.Header().Set("x-codex-primary-window-minutes", "300")
				w.Header().Set("x-codex-primary-reset-at", jsonInt(b.five))
				w.Header().Set("x-codex-secondary-used-percent", "10")
				w.Header().Set("x-codex-secondary-window-minutes", "10080")
				w.Header().Set("x-codex-secondary-reset-at", jsonInt(b.week))
			}
			w.Header().Set("Content-Type", "text/event-stream")
			io.WriteString(w, sse(`data: {"type":"response.created","response":{"id":"r1","model":"gpt-5.5"}}`))
			w.(http.Flusher).Flush()
			select {
			case <-time.After(hold):
			case <-r.Context().Done():
			}
			b.mu.Lock()
			b.used[acct] += b.cost(body)
			b.mu.Unlock()
			io.WriteString(w, sse(`data: {"type":"response.output_text.delta","delta":"pong"}`,
				`data: {"type":"response.completed","response":{"id":"r1","usage":{"input_tokens":7,"output_tokens":1}}}`))
		case "/backend-api/wham/usage":
			b.mu.Lock()
			told := math.Floor(b.used[acct])
			b.mu.Unlock()
			json.NewEncoder(w).Encode(map[string]any{"plan_type": "plus",
				"rate_limit": map[string]any{"allowed": true,
					"primary_window":   map[string]any{"used_percent": told, "limit_window_seconds": 18000, "reset_at": b.five},
					"secondary_window": map[string]any{"used_percent": 10, "limit_window_seconds": 604800, "reset_at": b.week}}})
		default:
			w.WriteHeader(404)
		}
	}))
	t.Cleanup(up.Close)
	was := provider.CodexBase
	provider.CodexBase = up.URL + "/backend-api/codex"
	t.Cleanup(func() { provider.CodexBase = was })
	return b
}

// capOverrun has sessions send turns at once, size(session, turn) bytes
// of input each, through the signed-in account capped at 90% from start
// (and the spares, uncapped), each till one is refused, and fails
// when the capped one spent past its cap: by more than the point its
// reading in whole percents may be under what it has spent.
func capOverrun(t *testing.T, sessions int, start float64, cost func([]byte) float64, size func(session, turn int) int, spares ...string) {
	t.Helper()
	codexSignedIn(t, spares...)
	const capAt = 90
	used := map[string]float64{"acct-1": start}
	for i := range spares {
		used[fmt.Sprintf("acct-%d", i+2)] = start
	}
	b := newAccountsBackend(t, used, cost, 40*time.Millisecond)
	t.Cleanup(func() {
		// a refused turn has the account read again, which outlives it:
		// done before CodexBase is put back
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		provider.LoginReadsDone(ctx)
	})
	nearCapAccounts(t, capAt, start, spares...)
	srv := New()
	var wg sync.WaitGroup
	var mu sync.Mutex
	codes := map[int]int{}
	for s := range sessions {
		wg.Go(func() {
			for n := range 60 {
				rec := httptest.NewRecorder()
				body := fmt.Sprintf(`{"model":"gpt-5.5","stream":true,"input":%q}`, strings.Repeat("x", size(s, n)))
				req := httptest.NewRequest("POST", CodexPath+"/responses", strings.NewReader(body))
				req.Header.Set("Authorization", "Bearer chatgpt-token")
				req.Header.Set("chatgpt-account-id", "acct-1")
				srv.Handler().ServeHTTP(rec, req)
				mu.Lock()
				codes[rec.Code]++
				mu.Unlock()
				if rec.Code != 200 {
					return
				}
			}
		})
	}
	wg.Wait()
	b.mu.Lock()
	got, turns := b.used["acct-1"], maps.Clone(b.turns)
	b.mu.Unlock()
	t.Logf("turns %v, codes %v, used %.2f%%", turns, codes, got)
	if got > capAt+1 {
		t.Fatalf("used %.2f%% of a %d%% cap (codes %v, turns %v); want at most %d%%", got, capAt, codes, turns, capAt+1)
	}
	if turns["acct-1"] == 0 {
		t.Fatal("the capped account took no turn")
	}
}

// Every turn spends four points, as a long conversation's turn does on
// ChatGPT Plus, with nothing learned yet of what a turn there spends (a
// magpie just started): the five sessions' turns, and the next five, all
// went before any reading had what one spent, and took the account from
// 60% to 92-96% of its 90% cap.
func TestCapOverrunHeavyTurns(t *testing.T) {
	capOverrun(t, 5, 60, func([]byte) float64 { return 4 }, func(int, int) int { return 10 })
}

// yalifesign on X, again: turns that don't spend alike, told in whole
// percents (one in four a long one at four points, the rest half a
// point). From 81%, the fourth turn took it to 86.5%, and the eighth was
// let in at 88% by the reading alone and spent four points on its own, to
// 92%. A long turn once seen, the account stops short of the cap by it;
// one longer than any before it in the window is the overrun left
// (docs/subsystems/gateway-routing.md).
func TestCapOverrunUnevenTurns(t *testing.T) {
	capOverrun(t, 1, 81, func(b []byte) float64 { return float64(bytes.Count(b, []byte("x"))) / 1000 }, func(_, n int) int {
		if n%4 == 3 {
			return 4000
		}
		return 500
	})
}

// sendCodexTurn sends one Codex turn through srv as acct-1, and answers
// its status and body.
func sendCodexTurn(srv *Server) (int, string) {
	rec := httptest.NewRecorder()
	req := httptest.NewRequest("POST", CodexPath+"/responses", strings.NewReader(`{"model":"gpt-5.5","stream":true,"input":"x"}`))
	req.Header.Set("Authorization", "Bearer chatgpt-token")
	req.Header.Set("chatgpt-account-id", "acct-1")
	srv.Handler().ServeHTTP(rec, req)
	return rec.Code, rec.Body.String()
}

// jumpedAccount is the signed-in account, capped at capAt, at start, each
// turn spending a hundredth of a point told in whole percents. Its first
// turn comes back, then its usage rises by jump with no turn of this
// magpie's out, as another computer signed in to the same account spends
// it, and the second turn's reply tells the rise: what a turn there
// spends is learned from it, taken as that one turn's (maxTurnSpend).
func jumpedAccount(t *testing.T, capAt int, start, jump float64) (*Server, *accountsBackend) {
	t.Helper()
	codexSignedIn(t)
	b := newAccountsBackend(t, map[string]float64{"acct-1": start}, func([]byte) float64 { return 0.01 }, 0)
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		provider.LoginReadsDone(ctx)
	})
	nearCapAccounts(t, capAt, start)
	srv := New()
	if code, body := sendCodexTurn(srv); code != 200 {
		t.Fatalf("first turn: %d %s", code, body)
	}
	b.mu.Lock()
	b.used["acct-1"] += jump
	b.mu.Unlock()
	if code, body := sendCodexTurn(srv); code != 200 {
		t.Fatalf("second turn: %d %s", code, body)
	}
	return srv, b
}

// learnedJump fails t unless srv learned the jump as one turn's: the
// tests built on jumpedAccount prove nothing without it.
func learnedJump(t *testing.T, srv *Server) {
	t.Helper()
	srv.turnSpend.mu.Lock()
	defer srv.turnSpend.mu.Unlock()
	for _, s := range srv.turnSpend.m {
		if s.learned && s.per == maxTurnSpend {
			return
		}
	}
	t.Fatalf("what a turn spends: %+v; want the jump learned as one turn's, %v", srv.turnSpend.m, maxTurnSpend)
}

// readSince has acct-1's usage read again once both of its turns came
// back, as magpie reads it every minute it is asked, and waits for the
// reading to say want.
func readSince(t *testing.T, srv *Server, want float64) {
	t.Helper()
	waitFor(t, "both turns back", func() bool {
		srv.lanes.mu.Lock()
		defer srv.lanes.mu.Unlock()
		for _, n := range srv.lanes.turns {
			if n >= 2 {
				return true
			}
		}
		return false
	})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if !provider.ReadUsageNow(ctx, "codex", "me@example.com") {
		t.Fatal("never read")
	}
	waitFor(t, fmt.Sprintf("read at %v%%", want), func() bool {
		n, _ := provider.Allowances("codex")["me@example.com"].For("gpt-5.5", time.Now())
		return n == want
	})
}

// #7877: an account at 35% of a 95% cap, signed in on another computer
// too. What that one spent was learned as one turn's, at maxTurnSpend,
// and each turn after it that left the reading at 35% was counted ahead
// of it at that again: six of them held the account ("a turn there has
// spent up to 63 points"), and nothing sent to it could move its reading
// till its week renewed. Read again with every turn back, they are a
// point ahead of it.
func TestNearCapUnmovedReadingHoldsNothing(t *testing.T) {
	srv, _ := jumpedAccount(t, 95, 25, 10)
	for n := range 12 {
		if code, body := sendCodexTurn(srv); code != 200 {
			t.Fatalf("turn %d at 35%% of a 95%% cap: %d %s", n+3, code, body)
		}
	}
	learnedJump(t, srv)
}

// A reply that says nothing of the usage brings no reading of the turns
// come back before it, though its turn counts them read (lanes.began).
// They stay ahead of the reading at what a turn spends, so the account is
// read again as they near its cap: taken as a point between them, turns
// of four points each went from a reading of 70% that never moved to the
// vendor's 100%, past a 95% cap.
func TestNearCapSilentRepliesStayAhead(t *testing.T) {
	srv, b := jumpedAccount(t, 95, 60, 10)
	b.mu.Lock()
	b.silent, b.cost = true, func([]byte) float64 { return 4 }
	b.mu.Unlock()
	codes := map[int]int{}
	for range 10 {
		code, _ := sendCodexTurn(srv)
		codes[code]++
		if code != 200 {
			break
		}
	}
	b.mu.Lock()
	got := b.used["acct-1"]
	b.mu.Unlock()
	if got > 96 {
		t.Fatalf("used %.2f%% of a 95%% cap (codes %v); want at most 96%%", got, codes)
	}
	if codes[200] == 0 {
		t.Fatalf("codes %v; want turns let in before it was held", codes)
	}
	learnedJump(t, srv)
}

// #7877: a reading begun after the last turn came back, as magpie reads
// one every minute it is asked, has that turn in it. Told nothing of it,
// the turn stayed ahead of the reading at maxTurnSpend, and the account
// at 81% of a 95% cap, a turn there taken to spend 5 points, was held
// (81 + 5 + 10 > 95) till its window renewed.
func TestNearCapReadingSinceTheLastTurnHasIt(t *testing.T) {
	srv, _ := jumpedAccount(t, 95, 70, 11)
	readSince(t, srv, 81)
	if code, body := sendCodexTurn(srv); code != 200 {
		t.Fatalf("at 81%% of a 95%% cap: %d %s", code, body)
	}
	learnedJump(t, srv)
}
