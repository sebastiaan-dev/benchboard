#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
__attribute__((noinline)) double compare_keys(long n) { double s = 0; for (long i = 0; i < n; i++) s += (double)(i % 7) * 1.0001; return s; }
__attribute__((noinline)) double probe(long n) { return compare_keys(n) + compare_keys(n / 2); }
__attribute__((noinline)) void wait_io(void) { usleep(150000); }
static void *worker(void *arg) { volatile double r = probe(60000000); (void)r; wait_io(); return NULL; }
int main(void) {
  pthread_t t[2];
  for (int i = 0; i < 2; i++) pthread_create(&t[i], NULL, worker, NULL);
  volatile double r = probe(30000000); (void)r;
  wait_io();
  for (int i = 0; i < 2; i++) pthread_join(t[i], NULL);
  return 0;
}
