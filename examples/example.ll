; ModuleID = 'example.c'
source_filename = "example.c"
target datalayout = "e-m:e-p270:32:32-p271:32:32-p272:64:64-i64:64-f80:128-n8:16:32:64-S128"
target triple = "x86_64-unknown-linux-gnu"

; Global variables
@.str = private unnamed_addr constant [14 x i8] c"Hello, World!\00", align 1
@global_var = global i32 42, align 4
@"complex.global" = external global i64

; Type definitions
%struct.Point = type { i32, i32 }
%"struct.My Complex" = type { double, double }

; Function declarations
declare i32 @printf(ptr noundef, ...) #0
declare ptr @malloc(i64 noundef) #1
declare void @free(ptr noundef) #2

; Function attributes
attributes #0 = { nounwind "frame-pointer"="all" }
attributes #1 = { nounwind allocsize(0) }
attributes #2 = { nounwind }

; Function definition with various features
define dso_local i32 @main(i32 noundef %argc, ptr noundef %argv) #0 {
entry:
  %retval = alloca i32, align 4
  %argc.addr = alloca i32, align 4
  %argv.addr = alloca ptr, align 8
  %i = alloca i32, align 4
  %sum = alloca i32, align 4
  store i32 0, ptr %retval, align 4
  store i32 %argc, ptr %argc.addr, align 4
  store ptr %argv, ptr %argv.addr, align 8
  store i32 0, ptr %i, align 4
  store i32 0, ptr %sum, align 4
  br label %for.cond

for.cond:                                         ; preds = %for.inc, %entry
  %0 = load i32, ptr %i, align 4
  %cmp = icmp slt i32 %0, 10
  br i1 %cmp, label %for.body, label %for.end

for.body:                                         ; preds = %for.cond
  %1 = load i32, ptr %i, align 4
  %2 = load i32, ptr %sum, align 4
  %add = add nsw i32 %2, %1
  store i32 %add, ptr %sum, align 4
  br label %for.inc

for.inc:                                          ; preds = %for.body
  %3 = load i32, ptr %i, align 4
  %inc = add nsw i32 %3, 1
  store i32 %inc, ptr %i, align 4
  br label %for.cond

for.end:                                          ; preds = %for.cond
  %call = call i32 (ptr, ...) @printf(ptr noundef @.str)
  %4 = load i32, ptr %sum, align 4
  ret i32 %4
}

; Example with different types and operations
define dso_local double @compute(double %x, double %y) #0 {
entry:
  %mul = fmul fast double %x, %y
  %add = fadd fast double %mul, 1.0
  %sqrt = call double @llvm.sqrt.f64(double %add)
  ret double %sqrt
}

; Intrinsic declaration
declare double @llvm.sqrt.f64(double) #3
attributes #3 = { nofree nosync nounwind readnone speculatable willreturn }

; Example with vectors
define <4 x float> @vector_add(<4 x float> %a, <4 x float> %b) {
  %result = fadd <4 x float> %a, %b
  ret <4 x float> %result
}

; Example with atomics
define i32 @atomic_increment(ptr %ptr) {
  %old = atomicrmw add ptr %ptr, i32 1 seq_cst, align 4
  ret i32 %old
}

; Example with switch
define i32 @handle_case(i32 %val) {
entry:
  switch i32 %val, label %default [
    i32 0, label %case0
    i32 1, label %case1
    i32 2, label %case2
  ]

case0:
  ret i32 100

case1:
  ret i32 200

case2:
  ret i32 300

default:
  ret i32 -1
}

; Example with phi nodes
define i32 @max(i32 %a, i32 %b) {
entry:
  %cmp = icmp sgt i32 %a, %b
  br i1 %cmp, label %then, label %else

then:
  br label %end

else:
  br label %end

end:
  %result = phi i32 [ %a, %then ], [ %b, %else ]
  ret i32 %result
}

; Metadata examples
!llvm.module.flags = !{!0, !1}
!llvm.ident = !{!2}

!0 = !{i32 1, !"wchar_size", i32 4}
!1 = !{i32 7, !"uwtable", i32 2}
!2 = !{!"clang version 17.0.0"}

