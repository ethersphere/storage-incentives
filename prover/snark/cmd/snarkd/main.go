// snarkd: setup, prover and tools of the SNARK settlement circuit (docs/SNARK-SETTLEMENT.md).
//
//	snarkd vectors                                   MiMC test vector for the Rust reference
//	snarkd check   -witness w.json                   solve the circuit without a proof (debugging)
//	snarkd setup   -p 32 -f 4 -e 16 -x 8 -out DIR    compile, trusted setup (local, for tests), Verifier.sol
//	snarkd prove   -keys DIR -witness w.json         make and verify a Groth16 proof
//	snarkd serve   -keys DIR -listen ADDR            keep the keys in memory; POST /prove with a witness
package main

import (
	"bufio"
	"bytes"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"time"

	"github.com/consensys/gnark-crypto/ecc"
	"github.com/consensys/gnark/backend"
	"github.com/consensys/gnark/backend/groth16"
	"github.com/consensys/gnark/backend/solidity"
	"github.com/consensys/gnark/constraint"
	"github.com/consensys/gnark/frontend"
	"github.com/consensys/gnark/frontend/cs/r1cs"
	"github.com/consensys/gnark/test"

	"swarm-snark/circuit"
)

func die(err error) {
	if err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

func compile(caps circuit.Caps) constraint.ConstraintSystem {
	t := time.Now()
	ccs, err := frontend.Compile(ecc.BN254.ScalarField(), r1cs.NewBuilder, circuit.New(caps))
	die(err)
	fmt.Fprintf(os.Stderr, "circuit P=%d F=%d E=%d X=%d: %d constraints (compiled in %s)\n",
		caps.P, caps.F, caps.E, caps.X, ccs.GetNbConstraints(), time.Since(t).Round(time.Millisecond))
	return ccs
}

func peakMB() uint64 {
	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	return m.Sys >> 20
}

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: snarkd vectors | check | setup | prove")
		os.Exit(2)
	}
	fs := flag.NewFlagSet(os.Args[1], flag.ExitOnError)
	p := fs.Int("p", 32, "anchored commits and reveals")
	f := fs.Int("f", 4, "forced commits and reveals")
	e := fs.Int("e", 16, "postage events")
	x := fs.Int("x", 8, "batch expiries")
	out := fs.String("out", "keys", "output directory (setup) or file (prove)")
	keys := fs.String("keys", "keys", "directory of setup")
	wfile := fs.String("witness", "", "witness JSON of the Rust reference")
	listen := fs.String("listen", "127.0.0.1:8099", "address of `snarkd serve`")
	die(fs.Parse(os.Args[2:]))

	switch os.Args[1] {
	case "vectors":
		vectors()

	case "mimc-sol":
		mimcSol()

	case "size":
		compile(circuit.Caps{P: *p, F: *f, E: *e, X: *x})

	case "check":
		data, err := os.ReadFile(*wfile)
		die(err)
		a, caps, err := circuit.Assignment(data)
		die(err)
		die(test.IsSolved(circuit.New(caps), a, ecc.BN254.ScalarField()))
		fmt.Println("ok: the witness satisfies the circuit")

	case "setup":
		ccs := compile(circuit.Caps{P: *p, F: *f, E: *e, X: *x})
		t := time.Now()
		pk, vk, err := groth16.Setup(ccs)
		die(err)
		fmt.Fprintf(os.Stderr, "setup in %s\n", time.Since(t).Round(time.Millisecond))
		die(os.MkdirAll(*out, 0o755))
		for name, obj := range map[string]interface {
			WriteRawTo(w io.Writer) (int64, error)
		}{"pk.bin": pk, "vk.bin": vk} {
			fh, err := os.Create(filepath.Join(*out, name))
			die(err)
			_, err = obj.WriteRawTo(fh)
			die(err)
			die(fh.Close())
		}
		fh, err := os.Create(filepath.Join(*out, "circuit.bin"))
		die(err)
		_, err = ccs.WriteTo(fh)
		die(err)
		die(fh.Close())
		var sol bytes.Buffer
		die(vk.ExportSolidity(&sol, solidity.WithPragmaVersion("^0.8.19")))
		die(os.WriteFile(filepath.Join(*out, "Verifier.sol"), sol.Bytes(), 0o644))
		meta, _ := json.Marshal(map[string]int{"p": *p, "f": *f, "e": *e, "x": *x, "constraints": ccs.GetNbConstraints()})
		die(os.WriteFile(filepath.Join(*out, "caps.json"), meta, 0o644))

	case "prove":
		pr := loadProver(*keys)
		data, err := os.ReadFile(*wfile)
		die(err)
		res, err := pr.prove(data)
		die(err)
		if fs.Lookup("out").Value.String() != "keys" {
			die(os.WriteFile(*out, res, 0o644))
		}
		fmt.Println(string(res))

	case "serve":
		pr := loadProver(*keys)
		http.HandleFunc("/prove", func(w http.ResponseWriter, r *http.Request) {
			data, err := io.ReadAll(r.Body)
			if err != nil {
				http.Error(w, err.Error(), http.StatusBadRequest)
				return
			}
			res, err := pr.prove(data)
			if err != nil {
				http.Error(w, err.Error(), http.StatusUnprocessableEntity)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			w.Write(res)
		})
		http.HandleFunc("/caps", func(w http.ResponseWriter, r *http.Request) {
			b, _ := os.ReadFile(filepath.Join(*keys, "caps.json"))
			w.Header().Set("Content-Type", "application/json")
			w.Write(b)
		})
		fmt.Fprintf(os.Stderr, "snarkd: listening on %s\n", *listen)
		die(http.ListenAndServe(*listen, nil))

	default:
		fmt.Fprintln(os.Stderr, "unknown command", os.Args[1])
		os.Exit(2)
	}
}

// prover holds the circuit and the keys of one setup.
type prover struct {
	ccs  constraint.ConstraintSystem
	pk   groth16.ProvingKey
	vk   groth16.VerifyingKey
	load time.Duration
	mu   sync.Mutex
}

func loadProver(dir string) *prover {
	t0 := time.Now()
	p := &prover{ccs: groth16.NewCS(ecc.BN254), pk: groth16.NewProvingKey(ecc.BN254), vk: groth16.NewVerifyingKey(ecc.BN254)}
	read := func(name string, into interface {
		UnsafeReadFrom(r io.Reader) (int64, error)
	}) {
		fh, err := os.Open(filepath.Join(dir, name))
		die(err)
		_, err = into.UnsafeReadFrom(bufio.NewReaderSize(fh, 1<<24))
		die(err)
		fh.Close()
	}
	fh, err := os.Open(filepath.Join(dir, "circuit.bin"))
	die(err)
	_, err = p.ccs.ReadFrom(bufio.NewReaderSize(fh, 1<<24))
	die(err)
	fh.Close()
	read("pk.bin", p.pk)
	read("vk.bin", p.vk)
	p.load = time.Since(t0)
	fmt.Fprintf(os.Stderr, "snarkd: %d constraints, keys loaded in %s\n", p.ccs.GetNbConstraints(), p.load.Round(time.Millisecond))
	return p
}

// prove makes a Groth16 proof for a witness of the Rust reference and checks it.
func (p *prover) prove(data []byte) ([]byte, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	a, _, err := circuit.Assignment(data)
	if err != nil {
		return nil, err
	}
	w, err := frontend.NewWitness(a, ecc.BN254.ScalarField())
	if err != nil {
		return nil, err
	}
	t1 := time.Now()
	proof, err := groth16.Prove(p.ccs, p.pk, w, solidity.WithProverTargetSolidityVerifier(backend.GROTH16))
	if err != nil {
		return nil, err
	}
	took := time.Since(t1)
	pub, err := w.Public()
	if err != nil {
		return nil, err
	}
	if err := groth16.Verify(proof, p.vk, pub, solidity.WithVerifierTargetSolidityVerifier(backend.GROTH16)); err != nil {
		return nil, err
	}
	var wj circuit.WitnessJSON
	if err := json.Unmarshal(data, &wj); err != nil {
		return nil, err
	}
	sp := proof.(interface{ MarshalSolidity() []byte }).MarshalSolidity()
	return json.Marshal(map[string]any{
		"proof":        "0x" + hex.EncodeToString(sp),
		"digest":       wj.Digest,
		"publicValues": wj.PublicValues,
		"loadMs":       p.load.Milliseconds(),
		"proveMs":      took.Milliseconds(),
		"peakMB":       peakMB(),
		"constraints":  p.ccs.GetNbConstraints(),
	})
}
