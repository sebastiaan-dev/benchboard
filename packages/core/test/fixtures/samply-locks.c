#include <pthread.h>
#include <stdio.h>
#include <unistd.h>
static pthread_mutex_t lock = PTHREAD_MUTEX_INITIALIZER;
static volatile double sink;
__attribute__((noinline)) static void spin(long n) { for (long i = 0; i < n; i++) sink += i * 0.5; }
static void *busy(void *arg) {
  (void)arg;
  pthread_mutex_lock(&lock);      /* holds the lock while computing */
  spin(400000000);
  pthread_mutex_unlock(&lock);
  return NULL;
}
static void *waiter(void *arg) {
  (void)arg;
  usleep(20000);
  pthread_mutex_lock(&lock);      /* blocks until busy() releases */
  spin(50000000);
  pthread_mutex_unlock(&lock);
  return NULL;
}
int main(void) {
  pthread_t a, b;
  pthread_create(&a, NULL, busy, NULL);
  pthread_create(&b, NULL, waiter, NULL);
  pthread_join(a, NULL);          /* main sleeps in join */
  pthread_join(b, NULL);
  printf("%f\n", sink);
  return 0;
}
