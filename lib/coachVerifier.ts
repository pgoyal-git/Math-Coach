import type { CoachSession } from "@/lib/sessionStore";
import type { VerificationResult } from "@/lib/coach-verifier/types";
import {
  isBadDivideByTenResult,
  isCorrectDivideByTenResult,
  isPowerOfTenSquareRootShortcut,
  repeatsOriginalProblem,
  verifyClearedLeadingFractionEquation,
  verifyCommonPowerFactorMove,
  verifyDivideBothSidesQuestion,
  verifyEquivalentLinearEquation,
  verifyEquivalentSimplification,
  verifyFactoredQuadraticInequality,
  verifyCoefficientRemovedFromPowerEquation,
  verifyMultiplyBothSidesQuestion,
  verifyPowerEquationSolution,
  verifyPowerOfPowerEquationReduction,
  verifySameBaseExponentEquation,
  verifySquareRootBothSidesQuestion,
  wasAskedToApplyMove,
} from "@/lib/coach-verifier/algebra";
import {
  verifyAbsoluteValueArithmeticRewrite,
  verifyArithmeticEquality,
  verifyCentsPerAcceptedCountSetup,
  verifyDigitRateTotalClaim,
  verifyMixedNumberEquality,
  verifyMetricUnitConversion,
  verifyNumericAssignmentRewrite,
  verifyPairedPowerObservation,
  verifyPercentChangeClaim,
  verifySuccessivePercentFactorSetup,
  verifySquareAssertions,
  verifyTargetMeanDeviationClaim,
  verifyTargetMeanFinalAnswer,
  verifyTargetMeanSumClaim,
} from "@/lib/coach-verifier/arithmetic";
import {
  verifyBaseConversion,
  verifyBaseConversionRestatement,
  verifyBaseDigitSum,
  verifyDigitPlaceAssertions,
  verifyListedNumbersMeetProblemDigitCondition,
} from "@/lib/coach-verifier/baseDigits";
import { verifyCanonicalNumericClaim } from "@/lib/coach-verifier/canonicalNumeric";
import {
  verifyCategorySelectionCombinatorics,
  verifyCombinationClaim,
  verifyDistinguishedRepresentativeOvercount,
  verifyFactorialClaim,
  verifyFactorialInequalityFinalAnswer,
  verifyFactorialProductEquality,
  verifyPermutationClaim,
  verifySimpleFactorialEquationFinalAnswer,
} from "@/lib/coach-verifier/combinatorics";
import {
  verifyCircleFormulaClaim,
  verifyConcentricCircleEqualRegionAreaClaim,
  verifyExteriorAngleTriangleClaim,
  verifyFractionalRectangleAreaClaim,
  verifyInscribedSquareLegSumClaim,
  verifyPythagoreanTripleClaim,
  verifyRectanglePerimeterAreaClaim,
  verifyRhombusAreaFormulaClaim,
  verifyRhombusDiagonalClaim,
  verifyRightTriangleHypotenuseClaim,
  verifyShoelaceQuadrilateralAreaClaim,
  verifySquareAreaSideClaim,
  verifySquareAreaPerimeterDifferenceClaim,
  verifySphereSurfaceAreaClaim,
  verifyStatedGirthConstraint,
  verifyTriangleAreaClaim,
} from "@/lib/coach-verifier/geometry";
import {
  verifyDivisorListClaim,
  verifyGcdLcmClaim,
  verifyModuloClaim,
  verifyMultipleOfElevenMissingDigitFinalAnswer,
  verifyMultipleOfElevenMissingDigitSetup,
  verifyNearestOddDifferenceSetup,
  verifyNearestOddExpressionClaim,
  verifyNearestOddFinalAnswer,
  verifyOddPerfectSquareFactorExponentOptions,
  verifyParityClaim,
  verifyPerfectSquareExponentPrinciple,
  verifyPrimeFactorizationClaim,
  verifySquareDivisorChoiceCount,
  verifySquareDivisorExponentOptions,
  verifySquareDivisorFactorization,
} from "@/lib/coach-verifier/numberTheory";
import {
  verifyArithmeticSequenceTermClaim,
  verifyConsecutiveRangeSumRewrite,
  verifyFunctionEvaluationClaim,
  verifyGeometricSequenceClaim,
} from "@/lib/coach-verifier/sequences";
import { normalizeStudentProseTypos } from "@/lib/coach-verifier/typos";

export type {
  VerificationIntent,
  VerificationResult,
  VerificationStatus,
} from "@/lib/coach-verifier/types";
export { normalizeMathText, strategyToText } from "@/lib/coach-verifier/context";

export function deterministicVerify(session: CoachSession, message: string): VerificationResult | null {
  const normalizedMessage = normalizeStudentProseTypos(message).text;

  const squareDivisorFactorization = verifySquareDivisorFactorization(
    session,
    normalizedMessage
  );
  if (squareDivisorFactorization) return squareDivisorFactorization;

  const squareDivisorExponentOptions = verifySquareDivisorExponentOptions(
    session,
    normalizedMessage
  );
  if (squareDivisorExponentOptions) return squareDivisorExponentOptions;

  const squareDivisorChoiceCount = verifySquareDivisorChoiceCount(
    session,
    normalizedMessage
  );
  if (squareDivisorChoiceCount) return squareDivisorChoiceCount;

  const multiplicationQuestion = verifyMultiplyBothSidesQuestion(session, normalizedMessage);
  if (multiplicationQuestion) return multiplicationQuestion;

  const divisionQuestion = verifyDivideBothSidesQuestion(session, normalizedMessage);
  if (divisionQuestion) return divisionQuestion;

  const squareRootQuestion = verifySquareRootBothSidesQuestion(session, normalizedMessage);
  if (squareRootQuestion) return squareRootQuestion;

  const baseConversionRestatement = verifyBaseConversionRestatement(session, normalizedMessage);
  if (baseConversionRestatement) return baseConversionRestatement;

  const baseConversion = verifyBaseConversion(normalizedMessage);
  if (baseConversion) return baseConversion;

  const digitPlaceAssertions = verifyDigitPlaceAssertions(normalizedMessage);
  if (digitPlaceAssertions) return digitPlaceAssertions;

  const listedNumbersDigitCondition = verifyListedNumbersMeetProblemDigitCondition(session, normalizedMessage);
  if (listedNumbersDigitCondition) return listedNumbersDigitCondition;

  const squareAssertions = verifySquareAssertions(normalizedMessage);
  if (squareAssertions) return squareAssertions;

  const digitRateTotalClaim = verifyDigitRateTotalClaim(session, normalizedMessage);
  if (digitRateTotalClaim) return digitRateTotalClaim;

  const targetMeanFinalAnswer = verifyTargetMeanFinalAnswer(session, normalizedMessage);
  if (targetMeanFinalAnswer) return targetMeanFinalAnswer;

  const targetMeanSumClaim = verifyTargetMeanSumClaim(session, normalizedMessage);
  if (targetMeanSumClaim) return targetMeanSumClaim;

  const targetMeanDeviationClaim = verifyTargetMeanDeviationClaim(session, normalizedMessage);
  if (targetMeanDeviationClaim) return targetMeanDeviationClaim;

  const centsPerAcceptedCountSetup = verifyCentsPerAcceptedCountSetup(session, normalizedMessage);
  if (centsPerAcceptedCountSetup) return centsPerAcceptedCountSetup;

  const metricUnitConversion = verifyMetricUnitConversion(normalizedMessage);
  if (metricUnitConversion) return metricUnitConversion;

  const statedGirthConstraint = verifyStatedGirthConstraint(
    session,
    normalizedMessage
  );
  if (statedGirthConstraint) return statedGirthConstraint;

  const sphereSurfaceAreaClaim = verifySphereSurfaceAreaClaim(
    session,
    normalizedMessage
  );
  if (sphereSurfaceAreaClaim) return sphereSurfaceAreaClaim;

  const inscribedSquareLegSumClaim = verifyInscribedSquareLegSumClaim(
    session,
    normalizedMessage
  );
  if (inscribedSquareLegSumClaim) return inscribedSquareLegSumClaim;

  const rightTriangleHypotenuseClaim = verifyRightTriangleHypotenuseClaim(session, normalizedMessage);
  if (rightTriangleHypotenuseClaim) return rightTriangleHypotenuseClaim;

  const exteriorAngleTriangleClaim = verifyExteriorAngleTriangleClaim(session, normalizedMessage);
  if (exteriorAngleTriangleClaim) return exteriorAngleTriangleClaim;

  const squareAreaPerimeterDifferenceClaim = verifySquareAreaPerimeterDifferenceClaim(session, normalizedMessage);
  if (squareAreaPerimeterDifferenceClaim) return squareAreaPerimeterDifferenceClaim;

  const pairedPowerObservation = verifyPairedPowerObservation(normalizedMessage);
  if (pairedPowerObservation) return pairedPowerObservation;

  const categorySelectionCombinatorics = verifyCategorySelectionCombinatorics(session, normalizedMessage);
  if (categorySelectionCombinatorics) return categorySelectionCombinatorics;

  const factorialInequalityFinalAnswer = verifyFactorialInequalityFinalAnswer(session, normalizedMessage);
  if (factorialInequalityFinalAnswer) return factorialInequalityFinalAnswer;

  const simpleFactorialEquationFinalAnswer = verifySimpleFactorialEquationFinalAnswer(session, normalizedMessage);
  if (simpleFactorialEquationFinalAnswer) return simpleFactorialEquationFinalAnswer;

  const combinationClaim = verifyCombinationClaim(normalizedMessage);
  if (combinationClaim) return combinationClaim;

  const factorialProductEquality = verifyFactorialProductEquality(normalizedMessage);
  if (factorialProductEquality) return factorialProductEquality;

  const factorialClaim = verifyFactorialClaim(normalizedMessage);
  if (factorialClaim) return factorialClaim;

  const permutationClaim = verifyPermutationClaim(normalizedMessage);
  if (permutationClaim) return permutationClaim;

  const distinguishedRepresentativeOvercount = verifyDistinguishedRepresentativeOvercount(session, normalizedMessage);
  if (distinguishedRepresentativeOvercount) return distinguishedRepresentativeOvercount;

  const baseDigitSum = verifyBaseDigitSum(session, normalizedMessage);
  if (baseDigitSum) return baseDigitSum;

  const commonPowerFactorMove = verifyCommonPowerFactorMove(session, normalizedMessage);
  if (commonPowerFactorMove) return commonPowerFactorMove;

  const divisorListClaim = verifyDivisorListClaim(normalizedMessage);
  if (divisorListClaim) return divisorListClaim;

  const gcdLcmClaim = verifyGcdLcmClaim(normalizedMessage);
  if (gcdLcmClaim) return gcdLcmClaim;

  const moduloClaim = verifyModuloClaim(normalizedMessage);
  if (moduloClaim) return moduloClaim;

  const parityClaim = verifyParityClaim(normalizedMessage);
  if (parityClaim) return parityClaim;

  const perfectSquareExponentPrinciple = verifyPerfectSquareExponentPrinciple(session, normalizedMessage);
  if (perfectSquareExponentPrinciple) return perfectSquareExponentPrinciple;

  const oddPerfectSquareFactorExponentOptions =
    verifyOddPerfectSquareFactorExponentOptions(session, normalizedMessage);
  if (oddPerfectSquareFactorExponentOptions) return oddPerfectSquareFactorExponentOptions;

  const multipleOfElevenMissingDigitFinalAnswer = verifyMultipleOfElevenMissingDigitFinalAnswer(session, normalizedMessage);
  if (multipleOfElevenMissingDigitFinalAnswer) return multipleOfElevenMissingDigitFinalAnswer;

  const multipleOfElevenMissingDigitSetup = verifyMultipleOfElevenMissingDigitSetup(session, normalizedMessage);
  if (multipleOfElevenMissingDigitSetup) return multipleOfElevenMissingDigitSetup;

  const nearestOddExpressionClaim = verifyNearestOddExpressionClaim(session, normalizedMessage);
  if (nearestOddExpressionClaim) return nearestOddExpressionClaim;

  const nearestOddDifferenceSetup = verifyNearestOddDifferenceSetup(session, normalizedMessage);
  if (nearestOddDifferenceSetup) return nearestOddDifferenceSetup;

  const nearestOddFinalAnswer = verifyNearestOddFinalAnswer(session, normalizedMessage);
  if (nearestOddFinalAnswer) return nearestOddFinalAnswer;

  const primeFactorizationClaim = verifyPrimeFactorizationClaim(normalizedMessage);
  if (primeFactorizationClaim) return primeFactorizationClaim;

  const pythagoreanTripleClaim = verifyPythagoreanTripleClaim(normalizedMessage);
  if (pythagoreanTripleClaim) return pythagoreanTripleClaim;

  const squareAreaSideClaim = verifySquareAreaSideClaim(session, normalizedMessage);
  if (squareAreaSideClaim) return squareAreaSideClaim;

  const triangleAreaClaim = verifyTriangleAreaClaim(normalizedMessage);
  if (triangleAreaClaim) return triangleAreaClaim;

  const rhombusAreaFormulaClaim = verifyRhombusAreaFormulaClaim(session, normalizedMessage);
  if (rhombusAreaFormulaClaim) return rhombusAreaFormulaClaim;

  const rhombusDiagonalClaim = verifyRhombusDiagonalClaim(session, normalizedMessage);
  if (rhombusDiagonalClaim) return rhombusDiagonalClaim;

  const fractionalRectangleAreaClaim = verifyFractionalRectangleAreaClaim(session, normalizedMessage);
  if (fractionalRectangleAreaClaim) return fractionalRectangleAreaClaim;

  const rectanglePerimeterAreaClaim = verifyRectanglePerimeterAreaClaim(session, normalizedMessage);
  if (rectanglePerimeterAreaClaim) return rectanglePerimeterAreaClaim;

  const concentricCircleEqualRegionAreaClaim = verifyConcentricCircleEqualRegionAreaClaim(session, normalizedMessage);
  if (concentricCircleEqualRegionAreaClaim) return concentricCircleEqualRegionAreaClaim;

  const shoelaceQuadrilateralAreaClaim = verifyShoelaceQuadrilateralAreaClaim(session, normalizedMessage);
  if (shoelaceQuadrilateralAreaClaim) return shoelaceQuadrilateralAreaClaim;

  const circleFormulaClaim = verifyCircleFormulaClaim(normalizedMessage);
  if (circleFormulaClaim) return circleFormulaClaim;

  const arithmeticSequenceTermClaim = verifyArithmeticSequenceTermClaim(normalizedMessage);
  if (arithmeticSequenceTermClaim) return arithmeticSequenceTermClaim;

  const consecutiveRangeSumRewrite = verifyConsecutiveRangeSumRewrite(session, normalizedMessage);
  if (consecutiveRangeSumRewrite) return consecutiveRangeSumRewrite;

  const geometricSequenceClaim = verifyGeometricSequenceClaim(normalizedMessage);
  if (geometricSequenceClaim) return geometricSequenceClaim;

  const functionEvaluationClaim = verifyFunctionEvaluationClaim(normalizedMessage);
  if (functionEvaluationClaim) return functionEvaluationClaim;

  const successivePercentFactorSetup = verifySuccessivePercentFactorSetup(
    session,
    normalizedMessage
  );
  if (successivePercentFactorSetup) return successivePercentFactorSetup;

  const canonicalNumericClaim = verifyCanonicalNumericClaim(session, normalizedMessage);
  if (canonicalNumericClaim) return canonicalNumericClaim;

  const absoluteValueArithmeticRewrite = verifyAbsoluteValueArithmeticRewrite(session, normalizedMessage);
  if (absoluteValueArithmeticRewrite) return absoluteValueArithmeticRewrite;

  const percentChangeClaim = verifyPercentChangeClaim(session, normalizedMessage);
  if (percentChangeClaim) return percentChangeClaim;

  const mixedNumberEquality = verifyMixedNumberEquality(normalizedMessage);
  if (mixedNumberEquality) return mixedNumberEquality;

  const arithmeticEquality = verifyArithmeticEquality(normalizedMessage, session);
  if (arithmeticEquality) return arithmeticEquality;

  const numericAssignmentRewrite = verifyNumericAssignmentRewrite(session, normalizedMessage);
  if (numericAssignmentRewrite) return numericAssignmentRewrite;

  const coefficientRemovedFromPowerEquation = verifyCoefficientRemovedFromPowerEquation(session, normalizedMessage);
  if (coefficientRemovedFromPowerEquation) return coefficientRemovedFromPowerEquation;

  const powerOfPowerEquationReduction = verifyPowerOfPowerEquationReduction(session, normalizedMessage);
  if (powerOfPowerEquationReduction) return powerOfPowerEquationReduction;

  const powerEquationSolution = verifyPowerEquationSolution(session, normalizedMessage);
  if (powerEquationSolution) return powerEquationSolution;

  const sameBaseExponentEquation = verifySameBaseExponentEquation(session, normalizedMessage);
  if (sameBaseExponentEquation) return sameBaseExponentEquation;

  const equivalentLinearEquation = verifyEquivalentLinearEquation(session, normalizedMessage);
  if (equivalentLinearEquation) return equivalentLinearEquation;

  const clearedLeadingFractionEquation = verifyClearedLeadingFractionEquation(session, normalizedMessage);
  if (clearedLeadingFractionEquation) return clearedLeadingFractionEquation;

  const equivalentSimplification = verifyEquivalentSimplification(session, normalizedMessage);
  if (equivalentSimplification) return equivalentSimplification;

  const factoredQuadraticInequality = verifyFactoredQuadraticInequality(session, normalizedMessage);
  if (factoredQuadraticInequality) return factoredQuadraticInequality;

  if (isBadDivideByTenResult(session, normalizedMessage)) {
    return {
      intent: "submitted_work",
      status: "incorrect",
      local_error:
        "Dividing both sides by 10 changes the right side too; the right side should not stay the same.",
      valid_progress: null,
      suggested_next_check: "Compute the new right side on your scratch paper, then write the equation again.",
      should_finish: false,
      confidence: 1,
      source: "deterministic",
    };
  }

  if (isCorrectDivideByTenResult(session, normalizedMessage)) {
    return {
      intent: "submitted_work",
      status: "correct",
      local_error: null,
      valid_progress: "That equation correctly applies dividing both sides by 10.",
      suggested_next_check: "What can you do next to simplify the squared expression or compare powers of 10?",
      should_finish: false,
      confidence: 1,
      source: "deterministic",
    };
  }

  if (isPowerOfTenSquareRootShortcut(session, normalizedMessage)) {
    return {
      intent: "submitted_work",
      status: "correct",
      local_error: null,
      valid_progress:
        "The line is valid because it combines dividing by 10 with taking the square root of a positive quantity.",
      suggested_next_check: "Identify what value of $x$ makes $10^x=100$.",
      should_finish: false,
      confidence: 1,
      source: "deterministic",
    };
  }

  if (wasAskedToApplyMove(session) && repeatsOriginalProblem(session, normalizedMessage)) {
    return {
      intent: "submitted_work",
      status: "incorrect",
      local_error: "That restates the original equation instead of applying the requested move.",
      valid_progress: null,
      suggested_next_check: "Apply the operation to both sides and write the changed equation.",
      should_finish: false,
      confidence: 1,
      source: "deterministic",
    };
  }

  return null;
}
